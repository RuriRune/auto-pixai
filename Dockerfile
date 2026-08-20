FROM node:20-slim

# Debian's apt package for adb is often several years stale and lacks
# newer commands (e.g. `adb pair` for Android 11+ wireless debugging).
# Pull Google's official platform-tools binary directly instead — the
# same one used on a typical desktop install.
RUN apt-get update && apt-get install -y --no-install-recommends unzip wget ca-certificates \
    && wget -q -O /tmp/platform-tools.zip https://dl.google.com/android/repo/platform-tools-latest-linux.zip \
    && unzip -q /tmp/platform-tools.zip -d /opt \
    && ln -s /opt/platform-tools/adb /usr/local/bin/adb \
    && rm /tmp/platform-tools.zip \
    && apt-get purge -y unzip wget \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY lib ./lib
COPY public ./public
COPY server.js claimer.js ./

# /data is mounted from Unraid for cookies.json, settings/status/schedule, and debug screenshots
VOLUME ["/data"]

ENV PORT=8080
# adb stores its key pair at $HOME/.android/adbkey(.pub). Pointing HOME at
# the persistent /data volume means that key survives container
# rebuilds/recreations — authorize it on the phone once, and it stays
# trusted forever instead of needing a fresh tap after every deploy.
ENV HOME=/data
EXPOSE 8080

CMD ["node", "/app/server.js"]
