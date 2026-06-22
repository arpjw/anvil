#!/usr/bin/env bash
# cloud/vm/image/setup.sh
#
# Builds the base rootfs image used by Firecracker microVMs in production.
# Do NOT run this locally — local dev uses the Docker image (see Dockerfile).
# This is intended to run on a host with KVM, qemu-img, debootstrap, and root.
#
# Output: /var/lib/anvil/base.ext4 — a 4 GiB ext4 rootfs ready for Firecracker.

set -euo pipefail

ROOTFS="/var/lib/anvil/base.ext4"
MOUNT="/mnt/anvil-rootfs"
SIZE_MIB=4096

# -----------------------------------------------------------------------------
# 1. Create a blank ext4 image and bootstrap Ubuntu 22.04 into it.
# -----------------------------------------------------------------------------
mkdir -p /var/lib/anvil
truncate -s "${SIZE_MIB}M" "$ROOTFS"
mkfs.ext4 -F "$ROOTFS"

mkdir -p "$MOUNT"
mount -o loop "$ROOTFS" "$MOUNT"

debootstrap --variant=minbase jammy "$MOUNT" http://archive.ubuntu.com/ubuntu/

# -----------------------------------------------------------------------------
# 2. Install runtime dependencies inside the rootfs.
#    - Node.js 20 (for the agent runtime)
#    - git (for repo cloning inside the VM)
#    - ripgrep (used by Anvil's text_search tool)
#    - typescript-language-server (used by Anvil's LSP integration)
# -----------------------------------------------------------------------------
chroot "$MOUNT" /bin/bash -eux <<'CHROOT_EOF'
  apt-get update
  apt-get install -y curl ca-certificates git ripgrep
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  npm install -g typescript-language-server typescript anvil-agent
CHROOT_EOF

# -----------------------------------------------------------------------------
# 3. Copy the runtime server into /runtime and build it.
# -----------------------------------------------------------------------------
mkdir -p "$MOUNT/runtime"
cp -r "$(dirname "$0")/../runtime/." "$MOUNT/runtime/"
chroot "$MOUNT" /bin/bash -eux <<'CHROOT_EOF'
  cd /runtime
  npm install
  npm run build
CHROOT_EOF

# -----------------------------------------------------------------------------
# 4. Install a systemd unit so the runtime server boots automatically.
#    The control plane connects to ws://<vm-ip>:8080 once boot completes.
# -----------------------------------------------------------------------------
cat > "$MOUNT/etc/systemd/system/anvil-runtime.service" <<'UNIT_EOF'
[Unit]
Description=Anvil VM agent runtime
After=network.target

[Service]
Type=simple
WorkingDirectory=/runtime
ExecStart=/usr/bin/node /runtime/dist/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT_EOF

chroot "$MOUNT" systemctl enable anvil-runtime.service

# -----------------------------------------------------------------------------
# 5. Unmount; the resulting ext4 image is the production rootfs.
# -----------------------------------------------------------------------------
umount "$MOUNT"
echo "rootfs built: $ROOTFS"
