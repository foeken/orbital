//! The JavaScript engine the window draws: a child process answering window.api calls (sidecar.js), one JSON object
//! per line each way. Calls are written in the order they are made, so a write and the read after it reach the
//! engine in that order; answers come back on a reader thread and pushes ("changed", "removed") on a channel.
use futures::channel::{mpsc, oneshot};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub type Reply = Result<Value, String>;
pub type Push = (String, Vec<Value>);

pub struct Engine {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>,
    next: AtomicU64,
    child: Mutex<Child>,
}

impl Engine {
    pub fn start() -> std::io::Result<(Arc<Engine>, mpsc::UnboundedReceiver<Push>)> {
        let script = std::env::var("ORBITAL_ENGINE")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/sidecar.js").to_string());
        // an app opened from Finder has no shell PATH, so node is also looked for where Homebrew puts it
        let node = std::env::var("ORBITAL_NODE").ok().or_else(|| {
            ["/opt/homebrew/bin/node", "/usr/local/bin/node"].into_iter().find(|p| std::path::Path::new(p).exists()).map(String::from)
        });
        let mut child = Command::new(node.unwrap_or_else(|| "node".into()))
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> = Default::default();
        let (tx, rx) = mpsc::unbounded();
        let waiting = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                    if let Some(answer) = waiting.lock().unwrap().remove(&id) {
                        let reply = match msg.get("error") {
                            Some(e) => Err(e.as_str().unwrap_or("engine error").to_string()),
                            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = answer.send(reply);
                    }
                } else if let Some(name) = msg.get("event").and_then(Value::as_str) {
                    let args = msg.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
                    let _ = tx.unbounded_send((name.to_string(), args));
                }
            }
            for (_, answer) in waiting.lock().unwrap().drain() {
                let _ = answer.send(Err("the engine stopped".into()));
            }
        });
        let engine = Engine { stdin: Mutex::new(stdin), pending, next: AtomicU64::new(1), child: Mutex::new(child) };
        Ok((Arc::new(engine), rx))
    }

    /// window.api's method by name; the request is written now, the answer awaited later.
    pub fn call(&self, method: &str, params: Value) -> impl Future<Output = Reply> + 'static {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, reply) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, answer);
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let wrote = {
            let mut w = self.stdin.lock().unwrap();
            writeln!(w, "{line}").and_then(|_| w.flush())
        };
        async move {
            wrote.map_err(|e| e.to_string())?;
            reply.await.unwrap_or_else(|_| Err("the engine stopped".into()))
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}
