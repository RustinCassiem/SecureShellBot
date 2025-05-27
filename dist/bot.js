"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Disable SSL verification for development only
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require("dotenv/config");
const telegraf_1 = require("telegraf");
const scriptExecutor_1 = require("./services/scriptExecutor");
const logger_1 = __importDefault(require("./logger"));
const ldapjs_1 = __importDefault(require("ldapjs"));
const node_ssh_1 = require("node-ssh");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Initialize bot with token from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not set in environment variables');
}
const bot = new telegraf_1.Telegraf(BOT_TOKEN);
const scriptExecutor = new scriptExecutor_1.ScriptExecutor();
const ssh = new node_ssh_1.NodeSSH();
const userStates = new Map();
const authenticatedUsers = new Set();
const userMessages = new Map();
// LDAP configuration
const LDAP_URL = process.env.LDAP_URL;
const LDAP_BASE_DN = process.env.LDAP_BASE_DN;
const LDAP_USER_DN = process.env.LDAP_USER_DN || 'uid';
// Whitelisted users (comma-separated user IDs in .env, e.g. WHITELISTED_USERS=12345,67890)
const WHITELISTED_USERS = process.env.WHITELISTED_USERS
    ? process.env.WHITELISTED_USERS.split(',').map(id => Number(id.trim()))
    : [];
// Log the whitelisted users for verification (without exposing them in user-facing logs)
logger_1.default.info(`Whitelisted users configured: ${WHITELISTED_USERS.length}`);
const SERVERS = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../servers.json'), 'utf-8'));
const SCRIPTS = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../commands.json'), 'utf-8'));
// Enhance the deleteMessages function for better cleanup
function deleteMessages(ctx, userId) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!userMessages.has(userId))
            return;
        const messagesToDelete = userMessages.get(userId) || [];
        logger_1.default.info(`Attempting to delete ${messagesToDelete.length} messages for user ${userId}`);
        let deletedCount = 0;
        let failedCount = 0;
        for (const msgId of messagesToDelete) {
            try {
                yield ctx.deleteMessage(msgId);
                deletedCount++;
            }
            catch (e) {
                // Some messages may be too old to delete (Telegram limitation)
                failedCount++;
            }
        }
        logger_1.default.info(`Deleted ${deletedCount}/${messagesToDelete.length} messages for user ${userId} (${failedCount} failed)`);
        userMessages.set(userId, []); // Clear tracked messages
    });
}
// Fix the trackMessage function
function trackMessage(ctx, userId, text, extra) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        // Replace console.log with logger.info
        if (extra && extra.reply_markup) {
            logger_1.default.info(`Sending keyboard: ${JSON.stringify(extra.reply_markup)}`);
        }
        const msg = yield ctx.reply(text, extra);
        if (!userMessages.has(userId)) {
            userMessages.set(userId, []);
        }
        if (msg && 'message_id' in msg) {
            (_a = userMessages.get(userId)) === null || _a === void 0 ? void 0 : _a.push(msg.message_id);
        }
        return msg;
    });
}
// Start command
bot.start((ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (!ctx.from)
        return;
    const userId = ctx.from.id;
    logger_1.default.info(`User ${ctx.from.username || userId} attempted to start the bot`);
    // Check if user is whitelisted
    if (WHITELISTED_USERS.length > 0 && !WHITELISTED_USERS.includes(userId)) {
        yield ctx.reply('You are not whitelisted to use this application. Please speak to the administrator of this bot to request access.');
        logger_1.default.info(`Access denied for user ${ctx.from.username || userId} (ID: ${userId}) - not in whitelist`);
        return;
    }
    logger_1.default.info(`User ${ctx.from.username || userId} started the bot`);
    userStates.delete(userId);
    authenticatedUsers.delete(userId);
    yield deleteMessages(ctx, userId);
    // Start authentication flow
    yield trackMessage(ctx, userId, 'Welcome! Please enter your username:');
    userStates.set(userId, { step: 'awaiting_username' });
}));
// LDAP authentication
function authenticateLDAP(username, password) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve) => {
            if (!LDAP_URL || !LDAP_BASE_DN || !process.env.LDAP_BIND_DN || !process.env.LDAP_BIND_PASSWORD) {
                logger_1.default.error("Missing LDAP configuration");
                return resolve(false);
            }
            logger_1.default.info(`Attempting LDAP authentication for user: ${username}`);
            const client = ldapjs_1.default.createClient({ url: LDAP_URL });
            // First bind with the service account
            client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_BIND_PASSWORD, (err) => {
                if (err) {
                    logger_1.default.error(`LDAP bind error: ${err.message}`);
                    client.unbind();
                    return resolve(false);
                }
                logger_1.default.info("LDAP bind successful");
                // Search for the user's DN
                const opts = {
                    filter: `(${LDAP_USER_DN}=${username})`,
                    scope: 'sub',
                    attributes: ['dn']
                };
                client.search(LDAP_BASE_DN, opts, (err, res) => {
                    if (err) {
                        client.unbind();
                        return resolve(false);
                    }
                    let userDN = '';
                    res.on('searchEntry', (entry) => {
                        // No logging of sensitive DN information
                        userDN = entry.dn.toString();
                    });
                    res.on('error', () => {
                        client.unbind();
                        return resolve(false);
                    });
                    res.on('end', () => {
                        if (!userDN) {
                            client.unbind();
                            return resolve(false);
                        }
                        // Try to bind as the user
                        const userClient = ldapjs_1.default.createClient({ url: LDAP_URL });
                        userClient.bind(userDN, password, (err) => {
                            userClient.unbind();
                            resolve(!err);
                        });
                        client.unbind();
                    });
                });
            });
        });
    });
}
// Logout command
bot.command('logout', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (!ctx.from)
        return;
    const userId = ctx.from.id;
    authenticatedUsers.delete(userId);
    userStates.delete(userId);
    yield deleteMessages(ctx, userId);
    // Try to delete the /logout command message itself
    if (ctx.message && 'message_id' in ctx.message) {
        try {
            yield ctx.deleteMessage(ctx.message.message_id);
        }
        catch (_a) { }
    }
}));
// Hear /logout as text
bot.hears('/logout', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (!ctx.from)
        return;
    const userId = ctx.from.id;
    authenticatedUsers.delete(userId);
    userStates.delete(userId);
    yield deleteMessages(ctx, userId);
    // Try to delete the /logout message itself
    if (ctx.message && 'message_id' in ctx.message) {
        try {
            yield ctx.deleteMessage(ctx.message.message_id);
        }
        catch (_b) { }
    }
}));
// Handle text messages based on user state
bot.on('text', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (!ctx.from)
        return;
    const userId = ctx.from.id;
    const messageText = ctx.message.text.trim();
    const messageTextTrimmed = messageText.toLowerCase();
    // Replace the debug logging near the top of your bot.on('text') handler
    const state = userStates.get(userId);
    if (state && state.step === 'awaiting_password') {
        // Don't log the message content when a password is expected
        logger_1.default.info(`Received password input from ${userId}`);
        logger_1.default.info(`Current state for user ${userId}: ${state.step}`);
    }
    else {
        // Safe to log the message for other states
        logger_1.default.info(`Received message from ${userId}: "${messageText}"`);
        logger_1.default.info(`Current state for user ${userId}: ${state ? state.step : 'no state'}`);
    }
    // Handle /logout immediately
    if (messageTextTrimmed === '/logout') {
        authenticatedUsers.delete(userId);
        userStates.delete(userId);
        yield deleteMessages(ctx, userId);
        if (ctx.message && 'message_id' in ctx.message) {
            try {
                yield ctx.deleteMessage(ctx.message.message_id);
            }
            catch (_c) { }
        }
        return;
    }
    if (!state)
        return;
    // Username input
    if (state.step === 'awaiting_username') {
        state.username = messageText;
        state.step = 'awaiting_password';
        yield trackMessage(ctx, userId, 'Please enter your password:');
        return;
    }
    // Password input + authentication
    if (state.step === 'awaiting_password') {
        state.password = messageText;
        // Use LDAP authentication
        const isAuthenticated = yield authenticateLDAP(state.username, state.password);
        if (isAuthenticated) {
            logger_1.default.info(`User ${userId} authenticated successfully`);
            authenticatedUsers.add(userId);
            state.step = 'selecting_server';
            yield deleteMessages(ctx, userId);
            // Add a small delay
            yield new Promise(resolve => setTimeout(resolve, 500));
            try {
                yield ctx.reply('Authenticated!\n' +
                    'Welcome to SGT Linux Team Bot\n\n' +
                    'The following application is to assist application owners with day to day tasks, abuse of this application\n' +
                    'will be logged and reported and this bot will be shutdown immediately.\n\n');
                yield ctx.reply('Select a server:', telegraf_1.Markup.keyboard(SERVERS.map(s => [s.name]))
                    .oneTime()
                    .resize());
                logger_1.default.info(`Server keyboard sent to user ${userId}`);
            }
            catch (error) {
                logger_1.default.error(`Failed to send keyboard: ${error}`);
            }
        }
        else {
            userStates.delete(userId);
            yield trackMessage(ctx, userId, 'Authentication failed. Please send /start to try again.');
        }
        return;
    }
    // Server selection
    if (state.step === 'selecting_server') {
        const server = SERVERS.find(s => s.name === messageText);
        if (!server) {
            yield trackMessage(ctx, userId, 'Invalid server. Please select a server from the list:');
            return;
        }
        logger_1.default.info(`User ${userId} is selecting server: ${messageText}`);
        logger_1.default.info(`Server found: ${server.name} (${server.ip})`);
        // Store selected server and its name
        state.selectedServer = server.ip;
        state.selectedServerName = server.name;
        state.step = 'awaiting_sudo_user';
        yield trackMessage(ctx, userId, 'Please enter the sudo user you want to use (e.g., webapps, wildfly, willy):', {
            reply_markup: { remove_keyboard: true }
        });
        return;
    }
    // Sudo user input
    if (state.step === 'awaiting_sudo_user') {
        state.sudoUser = messageText;
        state.step = 'selecting_script';
        logger_1.default.info(`Preparing to show command buttons for server ${state.selectedServerName}`);
        try {
            // Create a keyboard with all commands - one command per row
            const commandButtons = SCRIPTS.map(s => [{ text: s.name }]);
            // First send a message with the information
            yield ctx.reply(`Ready to run commands as ${state.sudoUser} on ${state.selectedServerName || state.selectedServer}:`);
            // Now send the keyboard with all commands
            yield ctx.reply('Select a command:', {
                reply_markup: {
                    keyboard: commandButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info(`All ${SCRIPTS.length} command buttons sent at once`);
        }
        catch (error) {
            logger_1.default.error(`Failed to send command buttons: ${error}`);
        }
        return;
    }
    // Script selection and execution
    if (state.step === 'selecting_script') {
        const script = SCRIPTS.find(s => s.name === messageText);
        if (!script) {
            yield trackMessage(ctx, userId, 'Invalid script. Please select a script from the list.');
            return;
        }
        logger_1.default.info(`User ${userId} is selecting script: ${messageText}`);
        const serverIp = state.selectedServer;
        const sudoUser = state.sudoUser;
        if (!serverIp || !sudoUser) {
            yield trackMessage(ctx, userId, 'Server or sudo user information missing. Please start over with /start');
            userStates.delete(userId);
            return;
        }
        try {
            yield trackMessage(ctx, userId, `Running command on ${serverIp}...`);
            // Connect using NodeSSH (safely handles credentials)
            logger_1.default.info(`Connecting to ${serverIp} as ${state.username}`); // Don't log password
            // Use redacted object for potential logging
            const sshConfig = {
                host: serverIp,
                username: state.username,
                password: "[REDACTED]" // For any logging in NodeSSH
            };
            // But use actual password for connection
            yield ssh.connect({
                host: serverIp,
                username: state.username,
                password: state.password
            });
            // Execute the command
            logger_1.default.info(`Executing command on ${serverIp} as sudo user: ${sudoUser}`);
            const result = yield ssh.execCommand(`echo '${script.command}' | sudo su - ${sudoUser}`, { execOptions: { pty: true } });
            const output = result.stdout || result.stderr;
            // Show output in chunks if it's large
            if (output.length > 4000) {
                const chunks = [];
                for (let i = 0; i < output.length; i += 4000) {
                    chunks.push(output.substring(i, i + 4000));
                }
                for (const chunk of chunks) {
                    yield trackMessage(ctx, userId, `\`\`\`\n${chunk}\n\`\`\``);
                }
            }
            else {
                yield trackMessage(ctx, userId, `\`\`\`\n${output}\n\`\`\``);
            }
            ssh.dispose();
            // After script execution, ask if user wants to run more commands
            state.step = 'asking_run_more_commands';
            // Try direct API format instead of using Markup helper
            yield ctx.reply('Do you want to run more commands?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Yes' }],
                        [{ text: 'No' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info('Sent Yes/No keyboard in direct format');
        }
        catch (error) {
            logger_1.default.error('Script execution error:', safeErrorMessage(error, state));
            yield trackMessage(ctx, userId, `Error executing script: ${safeErrorMessage(error, state)}`);
            // Ask if user wants to run more commands
            state.step = 'asking_run_more_commands';
            // Try direct API format for the keyboard
            yield ctx.reply('Do you want to run more commands?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Yes' }],
                        [{ text: 'No' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info('Sent Yes/No keyboard in direct format after error');
        }
        return;
    }
    // Handle "Do you want to run more commands?"
    if (state.step === 'asking_run_more_commands') {
        logger_1.default.info(`User responded to "Run more commands?": "${messageText}"`);
        if (messageTextTrimmed === 'yes') {
            state.step = 'asking_same_or_different_server';
            // Direct API format that works
            yield ctx.reply('Do you want to use the same server or a different one?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Same server' }],
                        [{ text: 'Different server' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info('Sent Same/Different server keyboard in direct format');
        }
        else if (messageTextTrimmed === 'no') {
            state.step = 'asking_logout_or_continue';
            // UPDATED: Use the same direct API format here
            yield ctx.reply('Do you want to logout or continue?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Logout' }],
                        [{ text: 'Continue' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info('Sent Logout/Continue keyboard in direct format');
        }
        else {
            yield trackMessage(ctx, userId, 'Please choose a valid option: "Yes" or "No".');
        }
        return;
    }
    // Handle "Do you want to logout or continue?"
    if (state.step === 'asking_logout_or_continue') {
        logger_1.default.info(`User responded to "Logout or continue?": "${messageText}"`);
        if (messageTextTrimmed === 'logout') {
            // Perform logout
            logger_1.default.info(`User ${userId} is logging out and clearing all messages`);
            // First delete all tracked messages
            yield deleteMessages(ctx, userId);
            // Then remove user data
            authenticatedUsers.delete(userId);
            userStates.delete(userId);
            // Delete the logout command message itself
            if (ctx.message && 'message_id' in ctx.message) {
                try {
                    yield ctx.deleteMessage(ctx.message.message_id);
                }
                catch (_d) { }
            }
            // Send final message and track it for future deletion
            const finalMsg = yield ctx.reply('You have been logged out. All messages cleared. Send /start to use the bot again.');
            // Optional: Delete the final message after a few seconds
            if (finalMsg && 'message_id' in finalMsg) {
                setTimeout(() => __awaiter(void 0, void 0, void 0, function* () {
                    try {
                        yield ctx.deleteMessage(finalMsg.message_id);
                    }
                    catch (_e) { }
                }), 5000);
            }
        }
        else if (messageTextTrimmed === 'continue') {
            // Continue - go back to server selection
            state.step = 'selecting_server';
            state.selectedServer = undefined;
            state.selectedServerName = undefined;
            state.sudoUser = undefined;
            logger_1.default.info(`User ${userId} continuing with new server selection`);
            // Use the direct API format that works with other buttons
            const serverButtons = SERVERS.map(s => [{ text: s.name }]);
            yield ctx.reply('Select a server:', {
                reply_markup: {
                    keyboard: serverButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info('Sent server selection keyboard in direct format');
        }
        else {
            yield trackMessage(ctx, userId, 'Please choose a valid option: "Logout" or "Continue".');
        }
        return;
    }
    // Handle "Same server or different server"
    if (state.step === 'asking_same_or_different_server') {
        logger_1.default.info(`User responded to "Same or different server?": "${messageText}"`);
        // REMOVE THIS LINE - it's causing the error by sending a space as text
        // await ctx.reply(' ', { reply_markup: { remove_keyboard: true } });
        // The keyboard comes with the next message anyway, so we don't need the separate removal
        if (messageTextTrimmed === 'same server') {
            state.step = 'awaiting_sudo_user';
            logger_1.default.info(`User ${userId} continuing with same server: ${state.selectedServerName}`);
            yield trackMessage(ctx, userId, 'Please enter the sudo user you want to use (e.g., webapps, wildfly, willy):', {
                reply_markup: { remove_keyboard: true }
            });
        }
        else if (messageTextTrimmed === 'different server') {
            state.step = 'selecting_server';
            state.selectedServer = undefined;
            state.selectedServerName = undefined;
            state.sudoUser = undefined;
            logger_1.default.info(`User ${userId} switching to a different server`);
            // Use the direct API format that works with other buttons
            const serverButtons = SERVERS.map(s => [{ text: s.name }]);
            yield ctx.reply('Select a server:', {
                reply_markup: {
                    keyboard: serverButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger_1.default.info('Sent server selection keyboard in direct format');
        }
        else if (messageTextTrimmed !== 'same server' &&
            messageTextTrimmed !== 'different server') {
            // Do nothing, just wait for a valid response
            return;
        }
        return;
    }
}));
// 2. Add a safer error handling function that won't expose passwords
function safeErrorMessage(error, state) {
    if (!error)
        return 'Unknown error';
    let message = error instanceof Error ? error.message : String(error);
    // Redact common password patterns
    message = message.replace(/password=['"][^'"]*[']/gi, "password='[REDACTED]'");
    message = message.replace(/password=[^&\s]+/gi, "password=[REDACTED]");
    // Also redact the actual password if it appears anywhere
    if (state && state.password) {
        message = message.replace(new RegExp(state.password, 'g'), '[REDACTED]');
    }
    return message;
}
// 3. Add this warning at the start of your script
logger_1.default.warn('WARNING: For security, ensure NODE_SSH_NO_DEBUG=1 is set in production to prevent credential logging');
// Launch the bot with proper error handling
try {
    logger_1.default.info('Attempting to launch bot...');
    bot.launch();
    logger_1.default.info('Bot launched successfully!');
    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
catch (error) {
    logger_1.default.error('Failed to launch bot:', error);
}
