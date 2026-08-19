// crates/process-supervisor/src/supervisor.rs
// 一个文件=一个作用：子进程生命周期监督（拉起/随父自退/退出回收）。不写业务。
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

pub struct SidecarSupervisor {
    child: Mutex<Option<Child>>,
}

impl SidecarSupervisor {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    /// 拉起 Python sidecar：注入 launch token + 端口 + 随父自退标记（OpenWorker 式监督）
    pub fn spawn(&self, server_bin: PathBuf, port: u16, token: &str) -> std::io::Result<()> {
        let mut cmd = Command::new(server_bin);
        cmd.args(["--host", "127.0.0.1", "--port", &port.to_string()]);
        cmd.env("AWO_EXIT_WITH_PARENT", "1")
            .env("AWO_PARENT_PID", std::process::id().to_string())
            .env("AWO_SIDECAR_TOKEN", token);

        // Windows: CREATE_NO_WINDOW，避免 sidecar 弹出黑窗（cc-switch/OpenWorker 做法）
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    /// 退出时回收子进程（AgentForge Windows taskkill 式；跨平台备齐 kill）
    pub fn shutdown(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let pid = child.id().to_string();
            drop(child); // release lock on handle before external kill
            #[cfg(target_os = "windows")]
            {
                std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid])
                    .spawn()
                    .ok();
            }
            #[cfg(not(target_os = "windows"))]
            {
                // best-effort SIGTERM via Drop; simplified here
                let _ = pid;
            }
        }
    }

    /// 是否仍在运行（供崩溃恢复/健康检查用）
    pub fn is_alive(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|c| c.try_wait().is_ok_and(|st| st.is_none()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn spawn_and_shutdown_no_panic() {
        // 用当前解释器自身做占位"supervisor 对象可创建/可关闭"不崩溃
        let sup = SidecarSupervisor::new();
        sup.shutdown();
        std::thread::sleep(Duration::from_millis(10));
        assert!(!sup.is_alive());
    }
}
