import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";

// 1. Polyfill Buffer globally for @causeway-sync/core delta encoding/decoding
import { Buffer } from "buffer";
global.Buffer = global.Buffer || Buffer;

import {
  computeDelta,
  encodeDelta,
  decodeDelta,
  uploadDelta,
  downloadDelta,
  DEFAULT_CHUNK_SIZE,
} from "@causeway-sync/core";

import { ExpoSqliteSyncStore, type AsyncSyncStore } from "./src/storage";

interface TodoData {
  title: string;
  completed: boolean;
}

interface TodoItem extends TodoData {
  id: string;
}

export default function App() {
  const [clientId, setClientId] = useState("");
  const [store, setStore] = useState<AsyncSyncStore<TodoData> | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  
  // Input fields
  const [inputText, setInputText] = useState("");
  const [relayUrl, setRelayUrl] = useState("http://192.168.1.100:3000"); // Update with your PC's LAN IP
  const [uploadSession, setUploadSession] = useState("session-mobile-A");
  const [downloadSession, setDownloadSession] = useState("session-mobile-B");
  const [role, setRole] = useState<"A" | "B">("A");

  // Status indicators
  const [syncStatus, setSyncStatus] = useState<"Idle" | "Syncing..." | "Synced" | string>("Idle");
  const [isInitializing, setIsInitializing] = useState(true);

  // Auto-generate a client ID on startup
  useEffect(() => {
    const randomId = "mobile-" + Math.random().toString(36).substring(2, 9);
    setClientId(randomId);
  }, []);

  // Initialize DB store when clientId is ready
  useEffect(() => {
    if (!clientId) return;

    let activeStore: AsyncSyncStore<TodoData> | null = null;

    async function initDb() {
      try {
        activeStore = await ExpoSqliteSyncStore.open<TodoData>("causeway_todos.db", clientId);
        setStore(activeStore);
        
        // Load initial state
        const state = await activeStore.getFullState();
        const loadedTodos = Object.entries(state).map(([key, entry]) => ({
          id: key.replace("todo:", ""),
          title: entry.value.title,
          completed: entry.value.completed,
        }));
        setTodos(loadedTodos);
      } catch (err: any) {
        console.error("Failed to initialize database", err);
        setSyncStatus(`DB Init failed: ${err.message || String(err)}`);
      } finally {
        setIsInitializing(false);
      }
    }

    initDb();

    return () => {
      if (activeStore) {
        activeStore.close().catch((err) => console.error("Error closing database", err));
      }
    };
  }, [clientId]);

  // Load todos from the local DB
  const loadTodos = async (activeStore = store) => {
    if (!activeStore) return;
    try {
      const state = await activeStore.getFullState();
      const loadedTodos = Object.entries(state).map(([key, entry]) => ({
        id: key.replace("todo:", ""),
        title: entry.value.title,
        completed: entry.value.completed,
      }));
      setTodos(loadedTodos);
    } catch (err: any) {
      console.error("Failed to load todos", err);
    }
  };

  // Add a new todo locally
  const handleAddTodo = async () => {
    if (!store || !inputText.trim()) return;

    const newId = Math.random().toString(36).substring(2, 9);
    const key = `todo:${newId}`;
    const value = { title: inputText.trim(), completed: false };

    try {
      await store.applyLocalWrite(key, value);
      setInputText("");
      await loadTodos();
    } catch (err: any) {
      setSyncStatus(`Failed to add todo: ${err.message || String(err)}`);
    }
  };

  // Toggle todo status locally
  const handleToggleTodo = async (id: string, currentTitle: string, currentCompleted: boolean) => {
    if (!store) return;
    const key = `todo:${id}`;
    const value = { title: currentTitle, completed: !currentCompleted };

    try {
      await store.applyLocalWrite(key, value);
      await loadTodos();
    } catch (err: any) {
      setSyncStatus(`Failed to update todo: ${err.message || String(err)}`);
    }
  };

  // Sync with relay server
  const handleSync = async () => {
    if (!store) return;
    setSyncStatus("Syncing...");

    try {
      // 1. Get all local changes from DB and compute delta
      const changes = await store.getChangesSince(0);
      const delta = computeDelta(changes);
      const encodedDelta = encodeDelta(delta);

      // 2. Upload to upload session
      await uploadDelta(uploadSession, encodedDelta, DEFAULT_CHUNK_SIZE, { relayUrl });

      // 3. Download from download session
      let downloadedDelta: Buffer;
      try {
        downloadedDelta = await downloadDelta(downloadSession, DEFAULT_CHUNK_SIZE, { relayUrl });
      } catch (err: any) {
        // If 404, it means the other side hasn't uploaded a sync session yet
        if (err.message?.includes("404") || err.message?.includes("not available")) {
          downloadedDelta = Buffer.alloc(0);
        } else {
          throw err;
        }
      }

      // 4. Apply remote delta to DB if downloaded
      if (downloadedDelta && downloadedDelta.length > 0) {
        const remoteState = decodeDelta<TodoData>(downloadedDelta);
        await store.applyRemoteState(remoteState);
      }

      // 5. Refresh UI list
      await loadTodos();
      setSyncStatus("Synced");
    } catch (err: any) {
      setSyncStatus(`Sync failed: ${err.message || String(err)}`);
    }
  };

  // Set roles to swap session IDs easily for local testing
  const selectRole = (selectedRole: "A" | "B") => {
    setRole(selectedRole);
    if (selectedRole === "A") {
      setUploadSession("session-mobile-A");
      setDownloadSession("session-mobile-B");
    } else {
      setUploadSession("session-mobile-B");
      setDownloadSession("session-mobile-A");
    }
  };

  if (isInitializing) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Initializing database...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardContainer}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Causeway Sync Demo</Text>
          <Text style={styles.clientId}>Client ID: {clientId}</Text>
        </View>

        {/* Configurations */}
        <View style={styles.configCard}>
          <Text style={styles.configLabel}>Relay Server URL:</Text>
          <TextInput
            style={styles.textInput}
            value={relayUrl}
            onChangeText={setRelayUrl}
            placeholder="http://192.168.x.x:3000"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.warningNote}>
            ⚠️ Do NOT use "localhost" or "127.0.0.1" from a physical phone. Replace with your PC's LAN IP address.
          </Text>

          {/* Role Swap */}
          <Text style={styles.configLabel}>Test Role Configuration:</Text>
          <View style={styles.roleContainer}>
            <TouchableOpacity
              style={[styles.roleButton, role === "A" && styles.activeRoleButton]}
              onPress={() => selectRole("A")}
            >
              <Text style={[styles.roleButtonText, role === "A" && styles.activeRoleButtonText]}>
                Role A (Sends A, Recvs B)
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.roleButton, role === "B" && styles.activeRoleButton]}
              onPress={() => selectRole("B")}
            >
              <Text style={[styles.roleButtonText, role === "B" && styles.activeRoleButtonText]}>
                Role B (Sends B, Recvs A)
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Sync Controls */}
        <View style={styles.syncCard}>
          <View style={styles.syncRow}>
            <Text style={styles.syncStatusText}>
              Status: <Text style={styles.syncStatusValue}>{syncStatus}</Text>
            </Text>
            <TouchableOpacity style={styles.syncButton} onPress={handleSync}>
              <Text style={styles.syncButtonText}>Sync Now</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Todo List */}
        <FlatList
          data={todos}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.todoItem}
              onPress={() => handleToggleTodo(item.id, item.title, item.completed)}
            >
              <View style={[styles.checkbox, item.completed && styles.checkboxChecked]} />
              <Text style={[styles.todoText, item.completed && styles.todoTextCompleted]}>
                {item.title}
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No todo items. Add one below!</Text>
          }
        />

        {/* Add Todo Input */}
        <View style={styles.inputContainer}>
          <TextInput
            style={[styles.textInput, styles.addInput]}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Add new todo item..."
          />
          <TouchableOpacity style={styles.addButton} onPress={handleAddTodo}>
            <Text style={styles.addButtonText}>Add</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F9F9F9",
  },
  keyboardContainer: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: "#666",
  },
  header: {
    padding: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#EAEAEA",
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#1C1C1E",
  },
  clientId: {
    fontSize: 12,
    color: "#8E8E93",
    marginTop: 4,
  },
  configCard: {
    padding: 12,
    margin: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    borderWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#EAEAEA",
  },
  configLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#3A3A3C",
    marginBottom: 6,
    marginTop: 4,
  },
  textInput: {
    height: 40,
    borderWidth: 1,
    borderColor: "#D1D1D6",
    borderRadius: 6,
    paddingHorizontal: 10,
    backgroundColor: "#FFFFFF",
    fontSize: 14,
  },
  warningNote: {
    fontSize: 11,
    color: "#FF9500",
    marginTop: 4,
    marginBottom: 8,
    lineHeight: 14,
  },
  roleContainer: {
    flexDirection: "row",
    gap: 8,
  },
  roleButton: {
    flex: 1,
    height: 36,
    borderWidth: 1,
    borderColor: "#007AFF",
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
  activeRoleButton: {
    backgroundColor: "#007AFF",
  },
  roleButtonText: {
    fontSize: 12,
    color: "#007AFF",
    fontWeight: "500",
  },
  activeRoleButtonText: {
    color: "#FFFFFF",
  },
  syncCard: {
    padding: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#EAEAEA",
  },
  syncRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  syncStatusText: {
    fontSize: 14,
    color: "#3A3A3C",
  },
  syncStatusValue: {
    fontWeight: "bold",
    color: "#007AFF",
  },
  syncButton: {
    backgroundColor: "#34C759",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  syncButtonText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 20,
  },
  todoItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#F0F0F0",
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#007AFF",
    marginRight: 12,
  },
  checkboxChecked: {
    backgroundColor: "#007AFF",
  },
  todoText: {
    fontSize: 16,
    color: "#1C1C1E",
  },
  todoTextCompleted: {
    textDecorationLine: "line-through",
    color: "#8E8E93",
  },
  emptyText: {
    textAlign: "center",
    color: "#8E8E93",
    marginTop: 40,
    fontSize: 14,
  },
  inputContainer: {
    flexDirection: "row",
    padding: 12,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#EAEAEA",
    gap: 8,
  },
  addInput: {
    flex: 1,
  },
  addButton: {
    backgroundColor: "#007AFF",
    width: 60,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 6,
  },
  addButtonText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 14,
  },
});
