[![donate](https://liberapay.com/assets/widgets/donate.svg)](https://liberapay.com/rkd/donate)

# [WIP] mx-puppet-xmpp
This is a xmpp puppeting bridge for matrix. It is based on [mx-puppet-bridge](https://github.com/Sorunome/mx-puppet-bridge) and provide multi-user instances.

##

## Quick start using Docker

To build docker image:

```
docker build -t mx-puppet-xmpp:latest .
```

For docker you probably want the following changes in `config.yaml`:

```yaml
bindAddress: '0.0.0.0'
filename: '/data/database.db'
file: '/data/bridge.log'
```

Also check the config for other values, like your homeserver domain.

## Install Instructions (from Source)

*   Clone and install:
    ```
    git clone https://github.com/Sorunome/mx-puppet-xmpp.git
    cd mx-puppet-xmpp
    npm install
*   Edit the configuration file and generate the registration file:
    ```
    cp sample.config.yaml config.yaml
    # fill info about your homeserver and xmpp app credentials to config.yaml manually
    npm run start -- -r # generate registration file
    or
    docker run -v </path/to/host>/data:/data -it mx-puppet-xmpp -r
    ```
*   Copy the registration file to your synapse config directory.
*   Add the registration file to the list under `app_service_config_files:` in your synapse config.
*   Restart synapse.
*   Start the bridge:
    ```
    npm run start
    ```
*   Start a direct chat with the bot user (`@_xmpppuppet_bot:domain.tld` unless you changed the config).
    (Give it some time after the invite, it'll join after a minute maybe.)
*   Get your Xmpp username and password as below, and tell the bot user to link your xmpp account:
    ```
    link <username> <password>
    ```
*   Tell the bot user to list the available rooms: (also see `help`)
    ```
    list
    ```
    Clicking rooms in the list will result in you receiving an invite to the bridged room.

## Working

- link
- text messages (mx -> xmpp)
- text messages (xmpp -> mx)

## TODO

- replies
- edits
- deletes
- images
- files