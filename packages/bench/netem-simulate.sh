#!/bin/bash
# Simulates rural 2G: ~20kbps, 800ms latency, 10% packet loss.
# Run manually inside WSL Ubuntu with sudo. This script modifies Linux network
# interfaces and must not be run by the agent.
#
# WSL2 networking uses a virtualized NAT layer. Applying netem to the lo
# loopback interface inside WSL should affect traffic between processes running
# inside that same WSL instance. If the relay server and benchmark client are
# both run natively on Windows, this loopback throttling will not apply to them.

set -euo pipefail

sudo tc qdisc add dev lo root netem rate 20kbit delay 800ms loss 10%
echo "Network simulation applied. To remove: sudo tc qdisc del dev lo root netem"
