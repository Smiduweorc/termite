#!/bin/sh
# Vite inlines import.meta.env at *build* time. That is fine when you build on the
# machine that will serve the result, and useless for a published image: whatever
# VITE_API_URL happened to be set on the release runner would be frozen into the bundle
# for every person who pulls it, and no environment variable at `docker run` time could
# change it.
#
# So index.html ships with a placeholder instead, and this rewrites it once, on container
# start, before nginx binds its socket. nginx's own entrypoint runs every executable in
# /docker-entrypoint.d/ in filename order and then execs nginx, which is why this file
# needs no exec of its own.
#
# Only index.html is touched. The hashed asset files never contain the placeholder, and
# nginx.conf marks index.html no-store so nothing downstream can serve a stale API URL.
set -eu

INDEX=/usr/share/nginx/html/index.html
PLACEHOLDER=__TERMITE_API_URL__

: "${API_URL:=http://localhost:3000}"

# A trailing slash here would produce "https://api.example.com//trpc" downstream.
API_URL=${API_URL%/}

if ! [ -f "$INDEX" ]; then
	echo "termite: $INDEX is missing, refusing to start" >&2
	exit 1
fi

# On a container restart the substitution has already happened and the placeholder is
# gone. That is not an error, but it does mean API_URL cannot be changed by restarting
# the container - the image has to be recreated. Say so, rather than starting quietly
# with the old value and letting someone debug it from the browser console.
if grep -q "$PLACEHOLDER" "$INDEX"; then
	# | as the delimiter because the replacement is a URL and contains /.
	sed -i "s|$PLACEHOLDER|$API_URL|g" "$INDEX"
	echo "termite: serving with API_URL=$API_URL"
else
	echo "termite: index.html is already configured; API_URL is not re-read on restart" >&2
fi
