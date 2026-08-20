FROM node:20-slim

# Only need the adb client here — Chrome itself runs on the separate
# Android emulator container, connected to over ADB + Chrome DevTools
# Protocol. No Chrome/Xvfb install needed in this image anymore.
RUN apt-get update && apt-get install -y --no-install-recommends adb \
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
