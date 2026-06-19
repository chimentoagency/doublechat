use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{accept_async, tungstenite::Message};

type Tx = mpsc::UnboundedSender<Message>;

struct Room {
    peers: Vec<(u64, Tx)>,
    next_id: u64,
}

impl Room {
    fn new() -> Self {
        Self { peers: Vec::new(), next_id: 0 }
    }

    fn add(&mut self, tx: Tx) -> (u64, usize) {
        let id = self.next_id;
        self.next_id += 1;
        self.peers.push((id, tx));
        (id, self.peers.len())
    }

    fn remove(&mut self, id: u64) -> usize {
        self.peers.retain(|(peer_id, _)| *peer_id != id);
        self.peers.len()
    }

    fn count(&self) -> usize {
        self.peers.len()
    }

    fn broadcast(&self, msg: Message, exclude_id: u64) {
        for (id, tx) in &self.peers {
            if *id != exclude_id {
                let _ = tx.send(msg.clone());
            }
        }
    }

    fn broadcast_all(&self, msg: Message) {
        for (_, tx) in &self.peers {
            let _ = tx.send(msg.clone());
        }
    }

}

fn text(s: impl Into<String>) -> Message {
    Message::Text(s.into().into())
}

pub async fn start(port: u16) {
    let addr = format!("0.0.0.0:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => { eprintln!("Signaling server failed to bind: {}", e); return; }
    };

    let room: Arc<Mutex<Room>> = Arc::new(Mutex::new(Room::new()));
    println!("Signaling server listening on port {}", port);

    loop {
        if let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(handle_peer(stream, room.clone()));
        }
    }
}

async fn handle_peer(stream: tokio::net::TcpStream, room: Arc<Mutex<Room>>) {
    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };

    // Reject if room is full
    if room.lock().await.count() >= 2 {
        let (mut sink, _) = ws.split();
        let _ = sink.send(text(json!({"type":"full"}).to_string())).await;
        return;
    }

    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let (client_id, count) = room.lock().await.add(tx.clone());

    // Tell this client how many peers are connected (including themselves)
    let _ = tx.send(text(json!({"type":"peers","count":count}).to_string()));

    // Notify existing peer that someone joined
    room.lock().await.broadcast(
        text(json!({"type":"peer-joined","count":count}).to_string()),
        client_id,
    );

    // Forward queued messages to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() { break; }
        }
    });

    // Relay incoming signaling messages to the other peer
    while let Some(result) = stream.next().await {
        match result {
            Ok(msg) if msg.is_text() || msg.is_binary() => {
                room.lock().await.broadcast(msg, client_id);
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    send_task.abort();

    let (remaining, leave_msg) = {
        let mut r = room.lock().await;
        let n = r.remove(client_id);
        (n, text(json!({"type":"peer-left","count":n}).to_string()))
    };
    if remaining > 0 {
        room.lock().await.broadcast_all(leave_msg);
    }
}
