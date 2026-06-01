const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

webpush.setVapidDetails(
    'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY || 'BC51xjBDhUltI7cAwHMsNLwM9ClgGXVVtgkpdaoTlh6rQqTKBB308Bq0wCV4wuLIN0FR0SNdGxgZD0YqScSGwQE',
    process.env.VAPID_PRIVATE_KEY || 'opVZ_oEAyHKWK5Un_zHBfCpEJ3oVZaZz2DzE8P8WZU0'
);

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || "https://script.google.com/macros/s/AKfycbwTAMQ3fr53A5nwDFEChniR3srNYoXW6AQpQAaD4kszMVGei70UnkHw7qP2SNWMz9A/exec";
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
    // 新規追加: グループ管理用テーブル
    await db.execute(`
        CREATE TABLE IF NOT EXISTS chat_groups (
            group_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            creator_id TEXT NOT NULL
        )
    `);
    // 機能拡張: グループメンバー管理用テーブル
    await db.execute(`
        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            UNIQUE(group_id, user_id)
        )
    `);
    // 新規追加: 通知保存テーブル
    await db.execute(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            user_id TEXT PRIMARY KEY,
            subscription TEXT NOT NULL
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

// 新規追加: グループ作成用API（メンバー同時追加対応）
app.post('/api/groups/create', async (req, res) => {
    const { name, creatorId, members } = req.body; // members は配列想定
    if (!name || !creatorId) {
        return res.json({ success: false, message: "グループ名または作成者IDが不足しています。" });
    }
    const groupId = 'group_' + Math.random().toString(36).substring(2, 15);
    try {
        await db.execute({
            sql: "INSERT INTO chat_groups (group_id, name, creator_id) VALUES (?, ?, ?)",
            args: [groupId, name, creatorId]
        });

        // 作成者自身をメンバーに追加
        await db.execute({
            sql: "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
            args: [groupId, creatorId]
        });

        // 選択されたフレンドをメンバーに追加
        if (members && Array.isArray(members)) {
            for (const memberId of members) {
                await db.execute({
                    sql: "INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)",
                    args: [groupId, memberId]
                });
            }
        }

        res.json({ success: true, message: `グループ「${name}」を作成しました。` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 新規追加: グループ一覧取得用API
app.get('/api/groups', async (req, res) => {
    try {
        const result = await db.execute("SELECT group_id, name, creator_id FROM chat_groups");
        res.json({ success: true, groups: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 機能拡張: グループ所属メンバー一覧取得API
app.get('/api/groups/members', async (req, res) => {
    const { groupId } = req.query;
    if (!groupId) {
        return res.json({ success: false, message: "グループIDが不足しています。" });
    }
    try {
        const result = await db.execute({
            sql: "SELECT u.user_id, u.username FROM group_members gm JOIN users u ON gm.user_id = u.user_id WHERE gm.group_id = ?",
            args: [groupId]
        });
        res.json({ success: true, members: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 機能拡張: グループ削除API（オーナー権限チェック付き）
app.post('/api/groups/delete', async (req, res) => {
    const { groupId, userId } = req.body;
    if (!groupId || !userId) {
        return res.json({ success: false, message: "情報が不足しています。" });
    }
    try {
        const groupCheck = await db.execute({
            sql: "SELECT creator_id FROM chat_groups WHERE group_id = ?",
            args: [groupId]
        });

        if (groupCheck.rows.length === 0) {
            return res.json({ success: false, message: "グループが見つかりません。" });
        }

        if (groupCheck.rows[0].creator_id !== userId) {
            return res.json({ success: false, message: "グループを削除する権限がありません（オーナー限定）。" });
        }

        // グループ、メンバー、関連メッセージの削除
        await db.execute({ sql: "DELETE FROM chat_groups WHERE group_id = ?", args: [groupId] });
        await db.execute({ sql: "DELETE FROM group_members WHERE group_id = ?", args: [groupId] });
        await db.execute({ sql: "DELETE FROM messages WHERE channel = ?", args: [groupId] });

        res.json({ success: true, message: "グループを削除しました。" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 新規追加: 購読保存API追加
app.post('/api/save-subscription', async (req, res) => {
    const { userId, subscription } = req.body;
    try {
        await db.execute({
            sql: `
                INSERT OR REPLACE INTO
                push_subscriptions
                (user_id, subscription)
                VALUES (?, ?)
            `,
            args: [
                userId,
                JSON.stringify(subscription)
            ]
        });
        res.json({
            success: true
        });
    } catch(err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

io.on('connection', (socket) => {
    socket.on('join_channel', async (data) => {
        const { myId, friendId, isGroup, groupId } = data;
        let roomId = '';

        if (isGroup) {
            if (!groupId) return;
            roomId = groupId;
        } else {
            if (!myId || !friendId) return;
            roomId = [myId, friendId].sort().join('_');
        }

        socket.join(roomId);

        try {
            const result = await db.execute({
                sql: "SELECT * FROM messages WHERE channel = ? ORDER BY id ASC LIMIT 100",
                args: [roomId]
            });
            socket.emit('load_history', result.rows);
        } catch (err) {
            console.error("データ取得失敗:", err);
        }
    });

    socket.on('send_message', async (msgData) => {
        const { channel, myId, friendId, name, avatar, color, text, timestamp } = msgData;
        if (!channel) return;

        // channelに渡された値（DMの合体ID、またはgroup_から始まるグループID）をそのままroomIdとして扱う
        const roomId = channel;

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
                timestamp: timestamp
            };

            io.to(roomId).emit('receive_message', broadcastData);

            // メッセージ送信時に通知を追加
            const subs = await db.execute(
                "SELECT * FROM push_subscriptions"
            );
            for (const row of subs.rows) {
                const subscription = JSON.parse(row.subscription);
                await webpush.sendNotification(
                    subscription,
                    JSON.stringify({
                        title: name,
                        body: text
                    })
                ).catch(err => console.error("通知送信失敗:", err));
            }

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
                    timestamp: timestamp
                });

                // メッセージ送信時に通知を追加（フォールバック時）
                const subs = await db.execute(
                    "SELECT * FROM push_subscriptions"
                );
                for (const row of subs.rows) {
                    const subscription = JSON.parse(row.subscription);
                    await webpush.sendNotification(
                        subscription,
                        JSON.stringify({
                            title: name,
                            body: text
                        })
                    ).catch(err => console.error("通知送信失敗:", err));
                }

            } catch (innerErr) {
                console.error("最優先DB保存失敗:", innerErr);
            }
        }
    });

    // 投稿メッセージの「編集」要求の処理
    socket.on('edit_message', async (data) => {
        const { id, channel, text } = data;
        if (!id || !channel || !text) return;

        try {
            await db.execute({
                sql: "UPDATE messages SET text = ? WHERE id = ? AND channel = ?",
                args: [text, id, channel]
            });

            const result = await db.execute({
                sql: "SELECT * FROM messages WHERE id = ?",
                args: [id]
            });

            if (result.rows.length > 0) {
                io.to(channel).emit('message_updated', result.rows[0]);
            }
        } catch (err) {
            console.error("メッセージ編集失敗:", err);
        }
    });

    // 投稿メッセージの「削除」要求の処理
    socket.on('delete_message', async (data) => {
        const { id, channel } = data;
        if (!id || !channel) return;

        try {
            await db.execute({
                sql: "DELETE FROM messages WHERE id = ? AND channel = ?",
                args: [id, channel]
            });

            io.to(channel).emit('message_deleted', { id, channel });
        } catch (err) {
            console.error("メッセージ削除失敗:", err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
