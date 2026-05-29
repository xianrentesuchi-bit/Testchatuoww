const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycbwYsl3issVM1SgFyeuRVCITmIfex6kc7lmuiRXVpxbD195ctM0aAsyUxBV_NZxVz9UH/exec";
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "libsql://senninchat-senninch.aws-ap-northeast-1.turso.io",
    authToken: process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3Nzk4ODU4MzIsImlkIjoiMDE5ZTY5NTgtZTcwMS03NzhmLWFkYjAtMGQzMzM5ZDdlMDBlIiwicmlkIjoiZGU3ZTdlNTktYjZmMi00YWQ4LWIwNDMtYzkyMmY4ZDE2NGVkIn0.ER5t8rLt3YMoOWBv03igSfFH_z_O7JkdxedTLOOxv6HZ0SqiUa2Ef_Kre1qN0paLbTUkEpqlxlA5UrSSDvJkCA"
});

async function initDB() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            friend_id TEXT NOT NULL,
            UNIQUE(user_id, friend_id)
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS message_reactions (
            message_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            reaction_type TEXT NOT NULL,
            PRIMARY KEY (message_id, user_id)
        )
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS message_reads (
            message_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY (message_id, user_id)
        )
    `);
}
initDB().catch(console.error);

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            await db.execute({
                sql: "INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)",
                args: [result.userId, result.username]
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const fetch = (await import('node-fetch')).default;
        const gasRes = await fetch(`${GAS_WEBAPP_URL}?action=register&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            method: 'POST'
        });
        const result = await gasRes.json();

        if (result.success) {
            await db.execute({
                sql: "INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)",
                args: [result.userId, result.username]
            });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/friends/add', async (req, res) => {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
        return res.json({ success: false, message: "ユーザーIDまたはフレンドIDが不足しています。" });
    }
    if (userId === friendId) {
        return res.json({ success: false, message: "自分自身をフレンドに追加することはできません。" });
    }
    try {
        const userCheck = await db.execute({
            sql: "SELECT username FROM users WHERE user_id = ?",
            args: [friendId]
        });
        if (userCheck.rows.length === 0) {
            return res.json({ success: false, message: "該当する固有IDのユーザーがチャットシステムに見つかりません。" });
        }

        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [userId, friendId]
        });

        await db.execute({
            sql: "INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)",
            args: [friendId, userId]
        });

        res.json({ success: true, message: `フレンド「${userCheck.rows[0].username}」とお互いにフレンドになりました。` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/friends', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await db.execute({
            sql: "SELECT u.user_id, u.username FROM friends f JOIN users u ON f.friend_id = u.user_id WHERE f.user_id = ?",
            args: [userId]
        });
        res.json({ success: true, friends: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

io.on('connection', (socket) => {
    socket.on('join_channel', async (data) => {
        const { myId, friendId } = data;
        if (!myId || !friendId) return;

        const roomId = [myId, friendId].sort().join('_');
        socket.join(roomId);

        try {
            const result = await db.execute({
                sql: `SELECT m.*, 
                      (SELECT COUNT(*) FROM message_reactions WHERE message_id = m.id) as reaction_count,
                      (SELECT COUNT(*) FROM message_reactions WHERE message_id = m.id AND user_id = ?) as my_reaction,
                      (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id AND user_id = ?) as is_read
                      FROM messages m WHERE m.channel = ? ORDER BY m.id ASC LIMIT 100`,
                args: [myId, friendId, roomId]
            });
            socket.emit('load_history', result.rows);
        } catch (err) {
            console.error("データ取得失敗:", err);
        }
    });

    socket.on('send_message', async (msgData) => {
        const { myId, friendId, name, avatar, color, text, timestamp } = msgData;
        if (!myId || !friendId) return;

        const roomId = [myId, friendId].sort().join('_');

        try {
            const result = await db.execute({
                sql: "INSERT INTO messages (channel, name, avatar, color, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                args: [roomId, name, avatar, color, text, timestamp]
            });

            const insertedId = Number(result.lastInsertRowid);
            const broadcastData = {
                id: insertedId,
                channel: roomId,
                myId: myId,
                friendId: friendId,
                name: name,
                avatar: avatar,
                color: color,
                text: text,
                timestamp: timestamp,
                reaction_count: 0,
                my_reaction: 0,
                is_read: 0
            };

            io.to(roomId).emit('receive_message', broadcastData);
        } catch (err) {
            console.error("データ保存失敗:", err);
            try {
                const fallbackResult = await db.execute({
                    sql: "INSERT INTO messages (channel, name, avatar, color, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                    args: [roomId, name, avatar, color, text, timestamp]
                });
                const insertedId = Number(fallbackResult.lastInsertRowid);
                io.to(roomId).emit('receive_message', {
                    id: insertedId,
                    channel: roomId,
                    myId: myId,
                    friendId: friendId,
                    name: name,
                    avatar: avatar,
                    color: color,
                    text: text,
                    timestamp: timestamp,
                    reaction_count: 0,
                    my_reaction: 0,
                    is_read: 0
                });
            } catch (innerErr) {
                console.error("最優先DB保存失敗:", innerErr);
            }
        }
    });

    socket.on('toggle_reaction', async (data) => {
        const { messageId, userId, roomId } = data;
        if (!messageId || !userId) return;

        try {
            const check = await db.execute({
                sql: "SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ?",
                args: [messageId, userId]
            });

            if (check.rows.length > 0) {
                await db.execute({
                    sql: "DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?",
                    args: [messageId, userId]
                });
            } else {
                await db.execute({
                    sql: "INSERT INTO message_reactions (message_id, user_id, reaction_type) VALUES (?, ?, ?)",
                    args: [messageId, userId, 'default']
                });
            }

            const countResult = await db.execute({
                sql: "SELECT COUNT(*) as count FROM message_reactions WHERE message_id = ?",
                args: [messageId]
            });
            const count = countResult.rows[0].count;

            io.to(roomId).emit('reaction_updated', { messageId, count, userId });
        } catch (err) {
            console.error("リアクション処理失敗:", err);
        }
    });

    socket.on('mark_as_read', async (data) => {
        const { messageId, userId, roomId } = data;
        if (!messageId || !userId) return;

        try {
            await db.execute({
                sql: "INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)",
                args: [messageId, userId]
            });
            io.to(roomId).emit('message_read', { messageId, userId });
        } catch (err) {
            console.error("既読処理失敗:", err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
