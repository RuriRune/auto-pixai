FROM node:20-slim

# Chrome + Xvfb (Xvfb only needed for the visible-mode fallback)
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    xvfb \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
    libcairo2 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
    libxext6 libxss1 fonts-liberation \
    --no-install-recommends \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY lib ./lib
COPY public ./public
COPY server.js claimer.js start.sh ./
RUN chmod +x /app/start.sh

# /data is mounted from Unraid for cookies.json, status/schedule, and debug screenshots
VOLUME ["/data"]

ENV IS_DOCKER=true
ENV DISPLAY=:99
ENV PORT=8080
EXPOSE 8080

CMD ["/app/start.sh"]
