//! MCP 与前端之间的桥（S5）。
//!
//! 后端 `emit("mcp-ui-cmd")` → 前端执行（合成 DOM 事件）→ `invoke("mcp_ui_ack")` 回执。
//! 后端在这一侧等回执，所以**必须带超时并保证回收**：前端崩了/窗口关了/JS 抛异常，
//! 都不能让关联表无限增长（§4.7 铁律 2）。
//!
//! 并发的意义：限流之外的又一道闸门 —— 一个打转的 AI 不该能一口气塞进几千条界面命令，
//! 那会把 WebView 卡死（用户看到的是"程序卡了"，却找不到原因）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter; // AppHandle::emit 需要这个 trait 在作用域内
use tokio::sync::oneshot;

use super::protocol::{RpcError, E_INTERNAL, E_UI_BUSY, E_UI_TIMEOUT};

/// 等前端回执的超时（§4.5）
pub const UI_TIMEOUT_MS: u64 = 5_000;
/// 在途界面命令上限（§4.7 铁律 2）
pub const MAX_IN_FLIGHT: usize = 32;

/// 前后端桥的关联表
#[derive(Default)]
pub struct UiBridge {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl UiBridge {
    pub fn in_flight(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 发起一次前端调用并等回执。
    pub async fn call(
        &self,
        app: &tauri::AppHandle,
        op: &str,
        payload: Value,
    ) -> Result<Value, RpcError> {
        let app = app.clone();
        self.call_with(
            move |msg| app.emit("mcp-ui-cmd", msg).map_err(|e| e.to_string()),
            op,
            payload,
        )
        .await
    }

    /// 与 [`Self::call`] 同样的逻辑，但把"下发"抽象成一个闭包。
    /// 这样单测不需要真的 AppHandle，就能验证"回执解挂 / 超时回收 / 饱和拒绝"这些关键语义。
    pub async fn call_with<F>(&self, emit: F, op: &str, payload: Value) -> Result<Value, RpcError>
    where
        F: FnOnce(Value) -> Result<(), String>,
    {
        self.call_with_timeout(emit, op, payload, UI_TIMEOUT_MS).await
    }

    /// 带可注入超时的版本（测试用短超时，避免每个用例都等 5 秒）
    pub async fn call_with_timeout<F>(
        &self,
        emit: F,
        op: &str,
        payload: Value,
        timeout_ms: u64,
    ) -> Result<Value, RpcError>
    where
        F: FnOnce(Value) -> Result<(), String>,
    {
        if self.in_flight() >= MAX_IN_FLIGHT {
            return Err(RpcError::new(
                E_UI_BUSY,
                format!("在途界面命令已达上限 {}，请稍后重试", MAX_IN_FLIGHT),
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel::<Value>();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);

        // 下发失败（比如窗口已销毁）就地回收，不留悬挂条目
        if let Err(e) = emit(json!({ "cmdId": id, "op": op, "payload": payload })) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(RpcError::new(
                E_INTERNAL,
                format!("下发界面命令失败: {}", e),
            ));
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(v)) => Ok(v),
            // sender 被丢弃：说明条目已被回收（停服/清空时会走到这里）
            Ok(Err(_)) => Err(RpcError::new(E_UI_TIMEOUT, "前端回执通道已关闭")),
            Err(_) => {
                // 超时**必须**回收，否则关联表就是内存泄漏
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                // 前端没在超时内回执 = 桥真的出问题了（界面卡死/前端抛异常没回执）。
                // 上报一条（去重后最多 5 分钟一次），否则 AI 只会收到"超时"而不知道为什么。
                super::report::report(
                    "ui_bridge_timeout",
                    &format!("{}ms 内未收到前端回执（op={}）", timeout_ms, op),
                );
                Err(RpcError::new(
                    E_UI_TIMEOUT,
                    format!("前端 {}ms 内未回执（界面可能正忙或已关闭）", timeout_ms),
                ))
            }
        }
    }

    /// 前端回执。返回是否命中了一个在等的调用（false = 已超时被回收，可安全忽略）
    pub fn ack(&self, cmd_id: u64, value: Value) -> bool {
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&cmd_id);
        match tx {
            Some(t) => t.send(value).is_ok(),
            None => false,
        }
    }

    /// 停服/退出时清空（唤醒等待者，让它们立刻拿到"通道已关闭"而不是等超时）
    pub fn clear(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

/// 前端的 `{ ok, value, error }` → 工具的 Result。
///
/// 错误码刻意分开：
/// - `notFound`（控件路径不存在）→ `E_INVALID_PARAMS`：**请求**有问题，走协议级错误
/// - 其它失败（控件被禁用、值非法…）→ `E_DEVICE_NOT_READY`：工具确实跑了但没成功，走 `isError`
pub fn unwrap_ui_result(v: Value) -> Result<Value, RpcError> {
    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
    if ok {
        return Ok(v.get("value").cloned().unwrap_or(Value::Null));
    }
    let msg = v
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("前端执行失败")
        .to_string();
    let not_found = v.get("notFound").and_then(|b| b.as_bool()).unwrap_or(false);
    let disabled = v.get("disabledReason").and_then(|d| d.as_str());
    Err(RpcError::new(
        if not_found {
            super::protocol::E_INVALID_PARAMS
        } else {
            super::protocol::E_DEVICE_NOT_READY
        },
        match disabled {
            Some(r) if !r.is_empty() => format!("{}（{}）", msg, r),
            _ => msg,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn ack_resolves_the_pending_call() {
        let b = UiBridge::default();
        let (tx, rx) = oneshot::channel::<Value>();
        b.pending
            .lock()
            .unwrap()
            .insert(7, tx);
        assert_eq!(b.in_flight(), 1);
        assert!(b.ack(7, json!({"ok": true, "value": 1})));
        assert_eq!(b.in_flight(), 0, "回执后条目必须被移除");
        assert_eq!(rx.blocking_recv().unwrap()["value"], 1);
    }

    #[test]
    fn ack_for_unknown_or_expired_id_is_harmless() {
        // 超时被回收后前端才回执：不能再 panic，也不能复活条目
        let b = UiBridge::default();
        assert!(!b.ack(999, json!({})), "未知 cmdId 应返回 false");
        assert_eq!(b.in_flight(), 0);
    }

    #[test]
    fn clear_wakes_waiters() {
        let b = UiBridge::default();
        let (tx, rx) = oneshot::channel::<Value>();
        b.pending.lock().unwrap().insert(1, tx);
        b.clear();
        assert_eq!(b.in_flight(), 0);
        // sender 被丢弃 → 等待方立刻拿到 Err，而不是耗到 5s 超时
        assert!(rx.blocking_recv().is_err());
    }

    #[test]
    fn call_resolves_when_frontend_acks() {
        let rt = rt();
        let b = std::sync::Arc::new(UiBridge::default());
        rt.block_on(async {
            let b2 = b.clone();
            // 模拟前端：等命令注册进关联表 → 读出 cmdId → 回执
            let h = tokio::spawn(async move {
                for _ in 0..200 {
                    if b2.in_flight() > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                let id = {
                    *b2.pending
                        .lock()
                        .unwrap()
                        .keys()
                        .next()
                        .expect("命令应已注册进关联表")
                };
                assert!(b2.ack(id, json!({"ok": true, "value": {"path": "serial.conn.portSelect"}})));
            });

            let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
            let s = seen.clone();
            let r = b
                .call_with_timeout(
                    move |msg| {
                        s.lock().unwrap().push(msg["op"].as_str().unwrap_or("").to_string());
                        assert!(msg["cmdId"].as_u64().unwrap_or(0) > 0, "必须带 cmdId");
                        assert!(msg["payload"].is_object(), "必须带 payload");
                        Ok(())
                    },
                    "get",
                    json!({"path": "serial.conn.portSelect"}),
                    2000,
                )
                .await;
            h.await.unwrap();

            assert_eq!(
                seen.lock().unwrap().as_slice(),
                &["get".to_string()],
                "命令必须真的下发出去"
            );
            let v = r.expect("前端回执后应成功");
            // 注意：这里拿到的是**原始回执**（{"ok":…,"value":…}），
            // 解包成工具结果是 McpCore::ui_call 里 unwrap_ui_result 的事。
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"]["path"], "serial.conn.portSelect");
            assert_eq!(
                unwrap_ui_result(v).unwrap()["path"],
                "serial.conn.portSelect",
                "解包后应直接是工具结果"
            );
            assert_eq!(b.in_flight(), 0, "完成后不能残留条目");
        });
    }

    #[test]
    fn call_times_out_and_reaps_the_entry() {
        let rt = rt();
        let b = UiBridge::default();
        rt.block_on(async {
            // 前端永不回执
            let e = b
                .call_with_timeout(|_| Ok(()), "list", json!({}), 60)
                .await
                .unwrap_err();
            assert_eq!(e.code, E_UI_TIMEOUT);
            assert!(e.message.contains("60ms"), "错误信息要带超时值: {}", e.message);
            assert_eq!(b.in_flight(), 0, "超时后必须回收 —— 否则关联表就是内存泄漏");
            assert!(!b.ack(1, json!({})), "迟到的回执应被安全忽略（不能 panic）");
        });
    }

    #[test]
    fn saturated_bridge_rejects_instead_of_queueing() {
        let rt = rt();
        let b = UiBridge::default();
        {
            let mut m = b.pending.lock().unwrap();
            for i in 0..MAX_IN_FLIGHT {
                let (tx, _rx) = oneshot::channel();
                m.insert(i as u64 + 1, tx);
            }
        }
        rt.block_on(async {
            let e = b
                .call_with_timeout(|_| Ok(()), "list", json!({}), 50)
                .await
                .unwrap_err();
            assert_eq!(e.code, E_UI_BUSY, "饱和时必须立刻拒绝，而不是排队堆积把界面拖死");
            assert_eq!(b.in_flight(), MAX_IN_FLIGHT, "被拒的请求不该占位置");
        });
    }

    #[test]
    fn emit_failure_reaps_the_entry() {
        let rt = rt();
        let b = UiBridge::default();
        rt.block_on(async {
            let e = b
                .call_with_timeout(|_| Err("窗口已销毁".to_string()), "set", json!({}), 50)
                .await
                .unwrap_err();
            assert_eq!(e.code, E_INTERNAL);
            assert!(e.message.contains("窗口已销毁"));
            assert_eq!(b.in_flight(), 0, "下发失败也必须回收");
        });
    }

    #[test]
    fn unwrap_ui_result_maps_ok_and_error() {
        let ok = unwrap_ui_result(json!({"ok": true, "value": {"a": 1}})).unwrap();
        assert_eq!(ok["a"], 1);

        // 控件路径不存在 → 请求有问题（协议级 -32602）
        let e = unwrap_ui_result(json!({"ok": false, "notFound": true, "error": "未找到控件: x.y"}))
            .unwrap_err();
        assert_eq!(e.code, super::super::protocol::E_INVALID_PARAMS);
        assert!(e.message.contains("未找到控件"));

        // 控件被禁用 → 工具执行失败（isError），并把原因带出来
        let e2 = unwrap_ui_result(json!({
            "ok": false, "error": "控件当前不可用", "disabledReason": "串口未连接"
        }))
        .unwrap_err();
        assert_eq!(e2.code, super::super::protocol::E_DEVICE_NOT_READY);
        assert!(e2.message.contains("串口未连接"), "要把不可用原因带给 AI: {}", e2.message);

        // 连 error 字段都没有时也要给出可读消息，不能是空串
        let e3 = unwrap_ui_result(json!({"ok": false})).unwrap_err();
        assert!(!e3.message.is_empty());
    }
}
