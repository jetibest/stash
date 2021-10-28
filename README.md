# stash
Webserver and tools for stashing (modern clipboard).

## Installation

    cd /srv/
    git clone https://github.com/jetibest/stash
    cd /srv/stash
    npm install # dependencies: busboy, express


    systemctl enable /srv/stash/stash.service
    systemctl start stash
    
## Usage

### command-line interface

Write to stash at "my-message":

    > echo hello world | curl --data-binary @- http://localhost:8080/my-message

Read from stash at "my-message":

    > curl http://localhost:8080/my-message
    hello world

### web-interface

Use the website at http://localhost:8080/ to paste text or drag files for upload.
