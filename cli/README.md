# remoterm

CLI for [Remoterm](https://remoterm.io): attach to, or SSH into, terminal sessions running in the Remoterm app on your devices.

```
npm i -g remoterm        # Node >= 20

remoterm login           # GitHub device-code sign-in
remoterm ls              # devices and their running sessions
remoterm attach my-mac/claude-api [--view]   # type ~. at the start of a line to detach
remoterm ssh-config >> ~/.ssh/config         # then: ssh claude-api@my-mac.remoterm
```

`ssh <session>@<device>.remoterm` uses `remoterm connect %h` as a ProxyCommand. The SSH username is the session
name (or id); use `menu` to pick from a list. Your SSH public key must be on your GitHub account.

Credentials live in `~/.config/remoterm/credentials` (mode 0600; `$XDG_CONFIG_HOME` is honored).
Overrides: `REMOTERM_API`, `REMOTERM_TUNNEL_DOMAIN`.
