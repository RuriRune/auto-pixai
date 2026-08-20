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
EXPOSE 8080

CMD ["node", "/app/server.js"]
