FROM node:18-slim

# 1. Install Chrome and all necessary Linux dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    apt-transport-https \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Install dependencies INSIDE the container
COPY package*.json ./
RUN npm install --only=production

# 3. Copy your script
COPY app.js ./

# 4. Set Environment Defaults
ENV IS_DOCKER=true
ENV PIXAI_COOKIE=""

CMD ["node", "app.js"]