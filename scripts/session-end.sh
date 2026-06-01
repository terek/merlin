#!/bin/sh
# Merlin Go — SessionEnd hook
# Removes the lockfile for this process.
rm -f "$HOME/.merlin/sessions/$PPID.json"
