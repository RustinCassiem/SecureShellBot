# Use official Node.js LTS image
FROM node:20

# Install sshpass
RUN apt-get update && apt-get install -y sshpass openssh-client

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the source code
COPY . .

# Build TypeScript
RUN npx tsc

# Expose no ports (Telegram bots use polling)
# CMD to run the bot
CMD ["node", "dist/bot.js"]