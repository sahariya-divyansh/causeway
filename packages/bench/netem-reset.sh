#!/bin/bash
# Removes the WSL Ubuntu loopback netem rule applied by netem-simulate.sh.
# Run manually inside WSL Ubuntu with sudo.
#
# This only affects traffic between processes running inside the same WSL
# instance when lo is the interface under test. It does not throttle native
# Windows loopback traffic.

set -euo pipefail

sudo tc qdisc del dev lo root netem
