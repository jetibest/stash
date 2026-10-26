#!/bin/bash

set -e

./podman-build.sh

! [ /etc/containers/systemd ] || cp -f stash.container /etc/containers/systemd/

[ /etc/containers/systemd ] || systemctl enable /opt/stash/stash.service
