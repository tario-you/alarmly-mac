#!/bin/zsh
# Installs the watcher as a LaunchAgent (starts at login, restarts if it dies).
#   launchd/install.sh            install and start
#   launchd/install.sh --remove   stop and remove
set -e
label=com.wake.notify-watch
plist=~/Library/LaunchAgents/$label.plist
repo=${0:A:h:h}
if [[ "$1" == "--remove" ]]; then
  launchctl bootout gui/$(id -u)/$label 2>/dev/null || true
  rm -f $plist; echo "removed $label"; exit 0
fi
node=$(command -v node) || { echo "node not found (need Node 22.13+)"; exit 1; }
mkdir -p ~/.local/state/wake ~/Library/LaunchAgents
sed -e "s|__NODE__|$node|" -e "s|__REPO__|$repo|" -e "s|__HOME__|$HOME|" $repo/launchd/$label.plist > $plist
launchctl bootout gui/$(id -u)/$label 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $plist
echo "installed $plist"
echo "node: $node"
echo "Give that node binary Full Disk Access (System Settings > Privacy & Security > Full Disk Access > +, Cmd-Shift-G, paste the path),"
echo "then: launchctl kickstart -k gui/$(id -u)/$label"
echo "log:  tail -f ~/.local/state/wake/watch.log"
