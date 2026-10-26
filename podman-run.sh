#!/bin/bash

if [ "$1" == "stop" ]
then
    exec podman stop stash-pod
fi

args=()
args+=(--init)
args+=(--replace)
if [ -t 1 ]
then
    args+=(-it)
else
    args+=(-d)
fi

podman run --name stash-pod -p "${STASH_LISTEN_ADDRESS:127.0.0.1}:${STASH_LISTEN_PORT:-8080}:8080" stash
