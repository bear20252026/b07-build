//! C3 调度统计 IPC：只传递版本化 JSON 快照，不暴露任一语言的内部内存或数据库句柄。

use serde::{Deserialize, Serialize};

use crate::control_plane::{SchedulerStats, TaskControlPlane, TaskRunSnapshot, TaskRunState};

pub const SCHEDULER_STATS_PROTOCOL_VERSION: &str = "awo.scheduler.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireTaskRunState {
    Created,
    Running,
    Blocked,
    Completed,
    Failed,
}

impl From<WireTaskRunState> for TaskRunState {
    fn from(value: WireTaskRunState) -> Self {
        match value {
            WireTaskRunState::Created => Self::Created,
            WireTaskRunState::Running => Self::Running,
            WireTaskRunState::Blocked => Self::Blocked,
            WireTaskRunState::Completed => Self::Completed,
            WireTaskRunState::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerStatsMessage {
    pub schema_version: u8,
    pub protocol_version: String,
    pub task_id: String,
    pub run_id: String,
    pub profile_id: String,
    pub state: WireTaskRunState,
    pub stats: SchedulerStats,
    pub heartbeat_at_ms: u64,
}

impl SchedulerStatsMessage {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported scheduler stats schema {}",
                self.schema_version
            ));
        }
        if self.protocol_version != SCHEDULER_STATS_PROTOCOL_VERSION {
            return Err(format!(
                "unsupported scheduler stats protocol {}",
                self.protocol_version
            ));
        }
        if self.task_id.is_empty() || self.run_id.is_empty() || self.profile_id.is_empty() {
            return Err("scheduler stats identifiers must be non-empty".to_string());
        }
        if self.stats.started_nodes > self.stats.total_nodes
            || self.stats.completed_nodes > self.stats.total_nodes
            || self.stats.failed_nodes > self.stats.total_nodes
            || self.stats.blocked_nodes > self.stats.total_nodes
        {
            return Err("scheduler stats exceed total nodes".to_string());
        }
        Ok(())
    }
}

pub fn parse_scheduler_stats_message(input: &str) -> Result<SchedulerStatsMessage, String> {
    let message: SchedulerStatsMessage = serde_json::from_str(input)
        .map_err(|error| format!("invalid scheduler stats JSON: {error}"))?;
    message.validate()?;
    Ok(message)
}

pub fn serialize_scheduler_stats_message(
    message: &SchedulerStatsMessage,
) -> Result<String, String> {
    message.validate()?;
    serde_json::to_string(message)
        .map_err(|error| format!("cannot serialize scheduler stats JSON: {error}"))
}

/// 将 TypeScript 的调度快照投影为 Rust 控制面镜像。任务第一次上报时注册；之后只允许同一
/// task/profile 更新，且心跳仍由控制面拒绝倒退。调用方可把本函数包在 JSON-RPC 或文件监控 adapter 中。
pub fn apply_scheduler_stats_message(
    plane: &TaskControlPlane,
    message: SchedulerStatsMessage,
) -> Result<TaskRunSnapshot, String> {
    message.validate()?;
    let desired_state: TaskRunState = message.state.into();
    match plane.snapshot(&message.run_id) {
        Some(existing) => {
            if existing.task_id != message.task_id || existing.profile_id != message.profile_id {
                return Err(format!(
                    "run {} identity does not match control-plane snapshot",
                    message.run_id
                ));
            }
            plane.heartbeat(&message.run_id, message.heartbeat_at_ms)?;
            if existing.state != desired_state {
                plane.transition(&message.run_id, desired_state)?;
            }
            plane.record_stats(&message.run_id, message.stats)
        }
        None => {
            let snapshot = TaskRunSnapshot::new(
                message.task_id,
                message.run_id.clone(),
                message.profile_id,
                message.heartbeat_at_ms,
            );
            plane.register(snapshot)?;
            if desired_state != TaskRunState::Created {
                plane.transition(&message.run_id, desired_state)?;
            }
            plane.record_stats(&message.run_id, message.stats)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> SchedulerStatsMessage {
        SchedulerStatsMessage {
            schema_version: 1,
            protocol_version: SCHEDULER_STATS_PROTOCOL_VERSION.to_string(),
            task_id: "task-1".to_string(),
            run_id: "run-1".to_string(),
            profile_id: "build".to_string(),
            state: WireTaskRunState::Blocked,
            stats: SchedulerStats {
                total_nodes: 3,
                started_nodes: 3,
                completed_nodes: 3,
                failed_nodes: 0,
                blocked_nodes: 1,
                max_observed_concurrency: 2,
            },
            heartbeat_at_ms: 100,
        }
    }

    #[test]
    fn serializes_camel_case_contract_and_applies_to_new_control_plane_run() {
        let encoded = serialize_scheduler_stats_message(&message()).unwrap();
        assert!(encoded.contains("schemaVersion"));
        assert!(encoded.contains("maxObservedConcurrency"));
        let plane = TaskControlPlane::new();
        let snapshot =
            apply_scheduler_stats_message(&plane, parse_scheduler_stats_message(&encoded).unwrap())
                .unwrap();
        assert_eq!(snapshot.state, TaskRunState::Blocked);
        assert_eq!(snapshot.stats.max_observed_concurrency, 2);
    }

    #[test]
    fn rejects_unknown_fields_bad_versions_and_conflicting_run_identity() {
        assert!(parse_scheduler_stats_message(
            r#"{"schemaVersion":1,"protocolVersion":"awo.scheduler.v1","taskId":"t","runId":"r","profileId":"build","state":"running","stats":{"totalNodes":1,"startedNodes":1,"completedNodes":1,"failedNodes":0,"blockedNodes":0,"maxObservedConcurrency":1},"heartbeatAtMs":1,"extra":true}"#,
        )
        .is_err());
        let plane = TaskControlPlane::new();
        apply_scheduler_stats_message(&plane, message()).unwrap();
        let mut conflicting = message();
        conflicting.task_id = "other-task".to_string();
        conflicting.heartbeat_at_ms = 101;
        assert!(apply_scheduler_stats_message(&plane, conflicting).is_err());
    }
}
