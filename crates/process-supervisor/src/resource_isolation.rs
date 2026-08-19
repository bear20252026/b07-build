//! 一个文件=一个作用：将已批准的 extension 子进程放入管理员委托的 Linux cgroup v2 leaf。
//! 不挂载 cgroup、不提权、不启用 controller；根目录必须由 operator 预先委托并配置好。

use serde::{Deserialize, Serialize};
use std::fs::{create_dir, read_to_string, remove_dir, write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceEnforcementLevel {
    /// 预算只是上层请求；Host 不宣称 OS 已强制资源隔离。
    RequestedOnly,
    /// memory.max 是内核硬限制；CPU 累积用量由 Host poll 检测并 kill/reap。
    CgroupV2MemoryHardLimitCpuWatchdog,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceIsolationMode {
    RequestedOnly,
    /// 只能是 operator 委托的 cgroup v2 根目录，应用不会创建 mount 或修改 controller。
    CgroupV2DelegatedRoot(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceBudgetRequest {
    pub max_memory_mb: u32,
    pub max_cpu_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceLimitViolation {
    CpuTime,
    MemoryOom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CgroupV2Lease {
    path: PathBuf,
    max_cpu_usec: u64,
    initial_oom_kill_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceIsolationError(pub String);

impl std::fmt::Display for ResourceIsolationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ResourceIsolationError {}

impl ResourceIsolationMode {
    pub fn requested_only() -> Self {
        Self::RequestedOnly
    }

    pub fn cgroup_v2_delegated_root(root: PathBuf) -> Self {
        Self::CgroupV2DelegatedRoot(root)
    }

    pub fn enforcement_level(&self) -> ResourceEnforcementLevel {
        match self {
            Self::RequestedOnly => ResourceEnforcementLevel::RequestedOnly,
            Self::CgroupV2DelegatedRoot(_) => {
                ResourceEnforcementLevel::CgroupV2MemoryHardLimitCpuWatchdog
            }
        }
    }

    pub fn prepare_after_spawn(
        &self,
        extension_id: &str,
        revision: u64,
        pid: u32,
        budget: ResourceBudgetRequest,
    ) -> Result<Option<CgroupV2Lease>, ResourceIsolationError> {
        match self {
            Self::RequestedOnly => Ok(None),
            Self::CgroupV2DelegatedRoot(root) => {
                prepare_cgroup_v2(root, extension_id, revision, pid, budget).map(Some)
            }
        }
    }
}

impl CgroupV2Lease {
    pub fn violation(&self) -> Result<Option<ResourceLimitViolation>, ResourceIsolationError> {
        if oom_kill_count(&self.path)? > self.initial_oom_kill_count {
            return Ok(Some(ResourceLimitViolation::MemoryOom));
        }
        if cpu_usage_usec(&self.path)? > self.max_cpu_usec {
            return Ok(Some(ResourceLimitViolation::CpuTime));
        }
        Ok(None)
    }

    pub fn cleanup(&self) {
        let _ = remove_dir(&self.path);
    }
}

fn prepare_cgroup_v2(
    root: &Path,
    extension_id: &str,
    revision: u64,
    pid: u32,
    budget: ResourceBudgetRequest,
) -> Result<CgroupV2Lease, ResourceIsolationError> {
    if !root.is_dir() {
        return Err(ResourceIsolationError(
            "delegated cgroup v2 root is not a directory".to_string(),
        ));
    }
    if extension_id.is_empty()
        || revision == 0
        || pid == 0
        || budget.max_memory_mb == 0
        || budget.max_cpu_ms == 0
    {
        return Err(ResourceIsolationError(
            "invalid cgroup v2 resource lease request".to_string(),
        ));
    }
    // 文件名不采纳 extension 文本，避免 manifest 标识进入 host filesystem 路径。
    let path = root.join(format!("awo-extension-{pid}-{revision}"));
    create_dir(&path).map_err(|error| ResourceIsolationError(error.to_string()))?;
    let configured = (|| {
        write(
            path.join("memory.max"),
            (u64::from(budget.max_memory_mb) * 1024 * 1024).to_string(),
        )
        .map_err(|error| ResourceIsolationError(error.to_string()))?;
        let initial_oom_kill_count = oom_kill_count(&path)?;
        write(path.join("cgroup.procs"), pid.to_string())
            .map_err(|error| ResourceIsolationError(error.to_string()))?;
        Ok(CgroupV2Lease {
            path: path.clone(),
            max_cpu_usec: budget.max_cpu_ms.saturating_mul(1_000),
            initial_oom_kill_count,
        })
    })();
    if configured.is_err() {
        let _ = remove_dir(&path);
    }
    configured
}

fn cpu_usage_usec(path: &Path) -> Result<u64, ResourceIsolationError> {
    let cpu_stat = read_to_string(path.join("cpu.stat"))
        .map_err(|error| ResourceIsolationError(error.to_string()))?;
    parse_named_counter(&cpu_stat, "usage_usec")
}

fn oom_kill_count(path: &Path) -> Result<u64, ResourceIsolationError> {
    let memory_events = read_to_string(path.join("memory.events"))
        .map_err(|error| ResourceIsolationError(error.to_string()))?;
    parse_named_counter(&memory_events, "oom_kill")
}

fn parse_named_counter(contents: &str, name: &str) -> Result<u64, ResourceIsolationError> {
    contents
        .lines()
        .find_map(|line| {
            line.split_once(' ')
                .filter(|(key, _)| *key == name)
                .map(|(_, value)| value)
        })
        .ok_or_else(|| ResourceIsolationError(format!("missing {name} cgroup counter")))?
        .parse::<u64>()
        .map_err(|error| ResourceIsolationError(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "awo-resource-isolation-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        create_dir_all(&root).expect("root");
        root
    }

    #[test]
    fn requested_only_never_claims_os_enforcement() {
        assert_eq!(
            ResourceIsolationMode::requested_only().enforcement_level(),
            ResourceEnforcementLevel::RequestedOnly
        );
    }

    #[test]
    fn cgroup_lease_reports_cpu_and_oom_counters() {
        let root = temp_root();
        let leaf = root.join("leaf");
        create_dir_all(&leaf).expect("leaf");
        write(leaf.join("cpu.stat"), "usage_usec 10\n").expect("cpu");
        write(leaf.join("memory.events"), "oom_kill 0\n").expect("memory");
        let lease = CgroupV2Lease {
            path: leaf.clone(),
            max_cpu_usec: 10,
            initial_oom_kill_count: 0,
        };
        assert_eq!(lease.violation().expect("violation"), None);
        write(leaf.join("cpu.stat"), "usage_usec 11\n").expect("cpu updated");
        assert_eq!(
            lease.violation().expect("cpu violation"),
            Some(ResourceLimitViolation::CpuTime)
        );
        write(leaf.join("memory.events"), "oom_kill 1\n").expect("memory updated");
        assert_eq!(
            lease.violation().expect("oom violation"),
            Some(ResourceLimitViolation::MemoryOom)
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
