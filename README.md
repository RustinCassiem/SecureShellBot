# Telegram Bot Executor

This project is a Telegram bot that can execute scripts on remote servers. It allows authenticated users to select a server and run commands, then returns the output via Telegram.

## Overview

This bot allows authorized users to:
- Authenticate using LDAP credentials
- Select a target server
- Choose a sudo user to execute commands as
- Run predefined commands on the server
- View command results within Telegram

## Features

- Secure LDAP authentication system
- Execute commands on multiple remote servers
- Support for common system commands (df -h, docker ps, etc.)
- Clean UI with interactive keyboards
- Docker and Docker Compose support
- Customizable server list and commands

## Project Structure

```
telegram-bot
├── src
│   ├── bot.ts                # Entry point for the Telegram bot
│   ├── logger.ts             # Logging configuration
│   ├── services
│   │   └── scriptExecutor.ts # Service for executing scripts
│   └── types
│       └── index.ts          # Type definitions
├── servers.json              # Server configuration
├── commands.json             # Available commands
├── logs/                     # Log files directory
├── Dockerfile                # Docker configuration
├── docker-compose.yml        # Docker Compose configuration
├── .env                      # Environment variables
├── package.json              # NPM configuration file
├── tsconfig.json             # TypeScript configuration file
└── README.md                 # Project documentation
```

## Prerequisites

- Node.js v16+ and npm
- SSH access to target servers
- Telegram account and bot token (from BotFather)
- LDAP server for authentication
- For Docker: Docker and Docker Compose installed

## Installation

### Local Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd telegram-bot-working
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `.env` file in the project root with the following variables:
   ```
   BOT_TOKEN=your_telegram_bot_token
   LDAP_URL=ldap://your-ldap-server:389
   LDAP_BASE_DN=DC=EXAMPLE,DC=COM
   LDAP_USER_DN=uid
   LDAP_BIND_DN=uid=serviceaccount,ou=Systems,ou=Users,DC=EXAMPLE,DC=COM
   LDAP_BIND_PASSWORD=your_bind_password
   LDAP_GROUP_DN=cn=yourgroupname,ou=Groups,ou=YourOU,DC=EXAMPLE,DC=COM
   ```

4. Create or modify `servers.json` and `commands.json` in the project root directory:

   **servers.json**:
   ```json
   [
     { "name": "k8-webapps-dev", "ip": "server1.example.com" },
     { "name": "Docker Desktop", "ip": "server2.example.com" }
   ]
   ```

   **commands.json**:
   ```json
   [
     { "name": "COMMAND: Disk Usage", "command": "df -h" },
     { "name": "COMMAND: Restart Service", "command": "systemctl restart nginx" }
   ]
   ```

5. Compile TypeScript:
   ```bash
   # Build the TypeScript code
   npm run build
   
   # Watch mode (recompiles on changes)
   npm run build:watch
   ```

6. Run the bot:
   ```bash
   # Standard start
   npm start
   
   # Start with SSL certificate validation disabled (for development)
   set NODE_TLS_REJECT_UNAUTHORIZED=0 && npm start
   
   # Direct execution with ts-node (no build required)
   npx ts-node src/bot.ts
   
   # Using start.bat (Windows)
   start.bat
   ```
   
   Example start.bat file contents:
   ```batch
   @echo off
   echo Starting Telegram Bot...
   set NODE_TLS_REJECT_UNAUTHORIZED=0
   npx ts-node src/bot.ts
   pause
   ```

### Docker Setup

1. Build the Docker image:
   ```bash
   docker build -t telegram-bot .
   ```

2. Run the container:
   ```bash
   docker run --env-file .env telegram-bot
   ```

### Docker Compose Setup

1. Start the bot:
   ```bash
   docker compose up --build
   ```

2. To run in background:
   ```bash
   docker compose up -d
   ```

3. View logs:
   ```bash
   docker compose logs -f
   ```

## SSH Authentication

The bot uses LDAP credentials for both authentication and SSH connections. The user will be prompted to enter their LDAP credentials when starting the bot.

### SSH Connection Flow

1. User authenticates with LDAP credentials
2. Same credentials are used to SSH to the selected server
3. Commands are executed using `sudo su - <sudouser>` to switch to the target user
4. Command output is returned to Telegram

### Sudo User Requirements

The LDAP user must have sudoers permission on the target servers to run:
```
sudo su - <targetuser>
```

Example sudoers entry:
```
yourldapuser ALL=(webapps, wildfly, willy) NOPASSWD: ALL
```

## Troubleshooting

### SSL Certificate Error

If you encounter the following error:
```
2025-05-20 16:46:29 error: Failed to launch bot: FetchError: request to https://api.telegram.org/bot[TOKEN]/getMe failed, reason: unable to get local issuer certificate
```

**Solutions:**

1. **For development only** (not secure for production):
   ```bash
   set NODE_TLS_REJECT_UNAUTHORIZED=0
   npm start
   ```

2. **Alternative method** (Windows cmd):
   ```bash
   # In Command Prompt
   set NODE_TLS_REJECT_UNAUTHORIZED=0 && node dist/bot.js
   ```

3. **Using start.bat file**:
   Create a `start.bat` file in your project root:
   ```batch
   @echo off
   set NODE_TLS_REJECT_UNAUTHORIZED=0
   npx ts-node src/bot.ts
   ```
   Then run it by double-clicking or using `./start.bat`

4. **For production** (recommended):
   - Update your system's CA certificates
   - Make sure Node.js is using the correct certificate store
   - If you're behind a corporate proxy, add your company's root CA to Node.js

### LDAP Authentication Issues

If LDAP authentication fails:

1. Verify your LDAP connection parameters in the `.env` file
2. Check that the `LDAP_BASE_DN` is correctly formatted
3. Ensure the bind account has appropriate permissions
4. Try with a known working user/password combination

### SSH Connection Issues

If SSH connections to servers fail:

1. Ensure the LDAP user has SSH access to the target servers
2. Check that the LDAP user has sudo permissions to switch to the target user
3. The sudoers file on the server may need updating to allow the LDAP user to run `sudo su - <targetuser>` without a password

### Other Common Issues

1. **Bot doesn't respond to commands**
   - Verify BOT_TOKEN is correct
   - Ensure the bot is running
   - Check if proper permissions were given to the bot in BotFather

2. **Missing keyboard buttons**
   - Restart the Telegram app
   - Try using the mobile app instead of web/desktop version
   - Use explicit keyboard formats with fixed text options

3. **Docker container exits unexpectedly**
   - Check logs: `docker logs <container_id>`
   - Verify environment variables are correctly passed
   - Ensure proper network connectivity for the container

## Architecture Diagram

```
+-------------+         +---------------+
| Telegram    |         | Telegram Bot  |
| User        +-------->+ API Server    |
+-------------+         +---------------+
                                |
                                v
+--------------------------------------------------------------+
|                      Telegram Bot Executor                    |
|                                                              |
|  +-------------+      +----------------+      +------------+ |
|  |             |      |                |      |            | |
|  | Bot Core    +----->+ Authentication +----->+ Command    | |
|  | (bot.ts)    |      | (LDAP)         |      | Execution  | |
|  |             |      |                |      |            | |
|  +------+------+      +----------------+      +------+-----+ |
|         |                                            |       |
|         v                                            v       |
|  +-------------+      +----------------+      +------------+ |
|  | Message     |      | Configuration  |      | Logging    | |
|  | Handling    |      | - servers.json |      | System     | |
|  |             |      | - commands.json|      |            | |
|  +-------------+      +----------------+      +------------+ |
|                                                              |
+------+-----------------------------+------------------------+
       |                             |
       v                             v
+-------------+              +----------------+
| LDAP        |              | Target Servers |
| Server      |              | - Server 1     |
|             |              | - Server 2     |
+-------------+              | - Server n     |
                             +----------------+
```

### System Flow

1. User sends commands to the Telegram bot via the Telegram app
2. Telegram API forwards messages to the Bot Executor
3. Bot Core (bot.ts) processes the commands and manages user state
4. Authentication module validates user credentials against LDAP
5. Command Execution module connects to target servers via SSH
6. Target servers execute commands and return results
7. Results are sent back through the chain to the user
8. All activities are tracked by the logging system

### Component Details

#### User Interface Layer
- **Telegram Client**: Mobile/desktop app or web interface
- **Telegram API**: Handles message delivery between users and the bot

#### Application Layer
- **Bot Core**: Main controller, handles command routing and state management
- **Authentication**: LDAP integration for secure user verification
- **Command Execution**: SSH connection handling and command processing
- **Message Handling**: Formats messages, creates keyboards, tracks messages
- **Configuration**: External JSON files for servers and commands
- **Logging**: Tracks all activities and errors to files and console

#### External Systems
- **LDAP Server**: Directory service for user authentication
- **Target Servers**: Various servers where commands are executed

### Data Flow
1. User credentials → LDAP authentication
2. Server selection → Configuration lookup
3. Command selection → Target server execution
4. Command output → Formatted response to user

## Usage

1. Start a chat with your bot on Telegram
2. Send `/start` to begin
3. Enter your LDAP username
4. Enter your LDAP password
5. Select a server from the list
6. Enter the sudo user (e.g., webapps, wildfly)
7. Choose a command to execute
8. View the command output in the chat
9. Use `/logout` to end your session and clear the chat

## Security Notes

- The bot cannot delete user messages in private chats (Telegram limitation)
- For security, manually delete chat history after using the bot
- All passwords are redacted from logs
- SSH connections use the LDAP credentials securely

## Security Features

### User Whitelisting

For enhanced security, the bot can be configured to only allow specific Telegram users to interact with it:

1. Add the Telegram user IDs to the WHITELISTED_USERS variable in your .env file:

```
WHITELISTED_USERS=123456789,987654321
```

2. Modify the bot code to check if the user ID is in the whitelist before processing commands:

3. Multiple users should be separated by commas.

4. To get your Telegram user ID, you can:
- Send a message to @userinfobot on Telegram
- Forward a message to @JsonDumpBot and look for the "from_id" value

5. If WHITELISTED_USERS is not defined or empty, the bot will allow any user.

# SecureShellBot
