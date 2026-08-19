//! 一个文件=一个作用：Rust 控制面中的任务状态、心跳、统计和取消契约。
//! 不拉起进程、不运行工具、不写数据库；持久化与进程管理分别由其适配器负责。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskRunState {
    Created,
    Running,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}

impl TaskRunState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerStats {
    pub total_nodes: u32,
    pub started_nodes: u32,
    pub completed_nodes: u32,
    pub failed_nodes: u32,
    pub blocked_nodes: u32,
    pub max_observed_concurrency: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRunSnapshot {
    pub task_id: String,
    pub run_id: String,
    pub profile_id: String,
    pub state: TaskRunState,
    pub stats: SchedulerStats,
    pub heartbeat_at_ms: u64,
    pub cancel_requested: bool,
}

impl TaskRunSnapshot {
    #[must_use]
    pub fn new(
        task_id: impl Into<String>,
        run_id: impl Into<String>,
        profile_id: impl Into<String>,
        now_ms: u64,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            run_id: run_id.into(),
            profile_id: profile_id.into(),
            state: TaskRunState::Created,
            stats: SchedulerStats::default(),
            heartbeat_at_ms: now_ms,
            cancel_requested: false,
        }
    }
}

/// 进程监督器可消费的本地控制面。它只维护内存镜像，后续 SQLite 适配器可订阅同一快照。
#[derive(Debug, Default)]
pub struct TaskControlPlane {
    runs: Mutex<HashMap<String, TaskRunSnapshot>>,
}

impl TaskControlPlane {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, snapshot: TaskRunSnapshot) -> Result<(), String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "task control-plane lock poisoned".to_string())?;
        if runs.contains_key(&snapshot.run_id) {
            return Err(format!("run {} already registered", snapshot.run_id));
        }
        runs.insert(snapshot.run_id.clone(), snapshot);
        Ok(())
    }

    pub fn transition(&self, run_id: &str, state: TaskRunState) -> Result<TaskRunSnapshot, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "task control-plane lock poisoned".to_string())?;
        let snapshot = runs
            .get_mut(run_id)
            .ok_or_else(|| format!("run {run_id} not found"))?;
        if snapshot.state.is_terminal() {
            return Err(format!("run {run_id} is already terminal"));
        }
        snapshot.state = state;
        Ok(snapshot.clone())
    }

    pub fn heartbeat(&self, run_id: &str, at_ms: u64) -> Result<TaskRunSnapshot, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "task control-plane lock poisoned".to_string())?;
        let snapshot = runs
            .get_mut(run_id)
            .ok_or_else(|| format!("run {run_id} not found"))?;
        if at_ms < snapshot.heartbeat_at_ms {
            return Err(format!("heartbeat for run {run_id} moved backwards"));
        }
        snapshot.heartbeat_at_ms = at_ms;
        Ok(snapshot.clone())
    }

    pub fn record_stats(
        &self,
        run_id: &str,
        stats: SchedulerStats,
    ) -> Result<TaskRunSnapshot, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "task control-plane lock poisoned".to_string())?;
        let snapshot = runs
            .get_mut(run_id)
            .ok_or_else(|| format!("run {run_id} not found"))?;
        snapshot.stats = stats;
        Ok(snapshot.clone())
    }

    pub fn request_cancel(&self, run_id: &str) -> Result<TaskRunSnapshot, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "task control-plane lock poisoned".to_string())?;
        let snapshot = runs
            .get_mut(run_id)
            .ok_or_else(|| format!("run {run_id} not found"))?;
        if snapshot.state.is_terminal() {
            return Err(format!("run {run_id} is already terminal"));
        }
        snapshot.cancel_requested = true;
        Ok(snapshot.clone())
    }

    #[must_use]
    pub fn snapshot(&self, run_id: &str) -> Option<TaskRunSnapshot> {
        self.runs.lock().ok()?.get(run_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered_plane() -> TaskControlPlane {
        let plane = TaskControlPlane::new();
        plane
            .register(TaskRunSnapshot::new("task-1", "run-1", "build", 100))
            .expect("register run");
        plane
    }

    #[test]
    fn records_lifecycle_heartbeat_and_scheduler_stats() {
        let plane = registered_plane();
        assert_eq!(
            plane
                .transition("run-1", TaskRunState::Running)
                .unwrap()
                .state,
            TaskRunState::Running
        );
        assert_eq!(plane.heartbeat("run-1", 150).unwrap().heartbeat_at_ms, 150);
        let snapshot = plane
            .record_stats(
                "run-1",
                SchedulerStats {
                    total_nodes: 4,
                    started_nodes: 4,
                    completed_nodes: 3,
                    failed_nodes: 0,
                    blocked_nodes: 1,
                    max_observed_concurrency: 2,
                },
            )
            .unwrap();
        assert_eq!(snapshot.stats.blocked_nodes, 1);
    }

    #[test]
    fn rejects_duplicate_registration_and_backward_heartbeat() {
        let plane = registered_plane();
        assert!(plane
            .register(TaskRunSnapshot::new("task-2", "run-1", "plan", 100))
            .is_err());
        assert!(plane.heartbeat("run-1", 99).is_err());
    }

    #[test]
    fn cancellation_is_allowed_only_before_terminal_state() {
        let plane = registered_plane();
        assert!(plane.request_cancel("run-1").unwrap().cancel_requested);
        plane.transition("run-1", TaskRunState::Cancelled).unwrap();
        assert!(plane.request_cancel("run-1").is_err());
    }
}
