# stash
Webserver and tools for stashing (online clipboard).

## Installation

    cd /opt/
    git clone https://github.com/jetibest/stash
    cd /opt/stash
    ./podman-build.sh
    
    ./podman-run.sh
    
And use `./install.sh` to automatically run a daemon in the background.
    
## Usage

### command-line interface

Write to stash at "my-message":

    > echo hello world | curl --data-binary @- http://localhost:8080/my-message

Read from stash at "my-message":

    > curl http://localhost:8080/my-message
    hello world

### web-interface

Use the website at http://localhost:8080/ to paste text or drag files for upload.

## Configuration

You could set some environment variables in the container, to tune the behavior:

- `STASH_JAIL_PATH` - storage directory inside the container (defaults to `/var/cache/stash`).
- `STASH_MIN_FREE_BYTES` - refuse uploads when free disk space drops below this (defaults to `4 GiB`).
- `STASH_MAX_WRITE_BYTES` - upload budget between clean-ups (defaults to `5 GiB`).
- `STASH_MAX_FIELD_BYTES` - maximum size of a text field upload (defaults to `16 MiB`).
- `STASH_MAX_FILE_BYTES` - maximum size of a file upload (defaults to the value of `STASH_MAX_WRITE_BYTES`).
- `STASH_CLEAN_INTERVAL_MINUTES` - file expiry time (defaults to `360`, which is 6 hours).

