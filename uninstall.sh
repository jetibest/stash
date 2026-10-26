#!/bin/bash

set -e

! [ -e /etc/containers/systemd ] || rm -f /etc/containers/systemd/stash.container

! systemctl is-enabled stash || systemctl disable stash

podman rmi -f stash
