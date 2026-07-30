#!/bin/sh
set -e

# 0. Docker socket access (yantra H5): the runtime user is non-root (nodejs,
# uid 1001) but the host's /var/run/docker.sock is root:docker with a gid that
# varies per host. Started as root, we bridge the gap: put nodejs in a group
# matching the socket's gid, then drop privileges for everything else.
# No socket mounted (CI, plain deploys) ⇒ skip silently.
if [ "$(id -u)" = "0" ]; then
	if [ -S /var/run/docker.sock ]; then
		SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
		if [ "$SOCK_GID" != "0" ]; then
			if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
				addgroup -g "$SOCK_GID" dockersock
			fi
			SOCK_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
			addgroup nodejs "$SOCK_GROUP" 2>/dev/null || true
			echo "docker.sock gid=$SOCK_GID -> nodejs added to group $SOCK_GROUP"
		fi
	fi
	# Re-exec this script as nodejs; migrations and the server never run as root.
	exec su-exec nodejs "$0" "$@"
fi

# 1. Run database migrations
echo "Running database migrations..."
node dist/db/db_script.js up

# 2. Start the server via 'exec' to ensure Node is PID 1
echo "Starting server..."
exec "$@"
