//! 单调毫秒时钟：`session` 需要调用方提供 `now_ms`，本模块是那个提供者。
//!
//! ## 为什么不用 `SystemTime`
//!
//! 系统时钟**可以被往回拨**（NTP 校时、用户改时间、时区/夏令时切换）。超时判定
//! 依赖单调性：如果 `now_ms` 从 1000 跳回 900，一条本该在 1100 超时的命令就会
//! 永远不超时——表现为"偶尔卡死"，且只在特定机器上复现。
//!
//! 因此基准取 `Instant`（Rust 保证单调），只把**相对经过时间**换算成毫秒。
//!
//! ## 为什么基准时刻是"构造时"而不是"进程启动时"
//!
//! 每条连接一条时钟：连接的存活期外的时间没有意义，从 0 起算让日志里的
//! `elapsed_ms` 这类数字直接可读，不必减去一个进程启动偏移。

use std::time::Instant;

/// 单调毫秒时钟。
#[derive(Debug, Clone)]
pub struct MonotonicMillis {
    /// 计时基准。`Instant` 无法构造一个"过去"的值，也不需要——只做差值。
    origin: Instant,
}

impl Default for MonotonicMillis {
    fn default() -> Self {
        Self::new()
    }
}

impl MonotonicMillis {
    /// 以当前时刻为基准新建时钟。
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }

    /// 自基准起经过的毫秒数（首次调用通常返回 0 或极小值）。
    ///
    /// 换算用 `as_millis()` 后**饱和截断到 `u64`**：`as_millis()` 返回 `u128`，
    /// 直接 `as u64` 会在极端长运行时间下静默截断（约 5.8 亿年后，虽然不是实际
    /// 风险，但静默截断是一种应当避免的写法）。用 `try_into` 把"不可能发生"
    /// 变成"显式处理"。
    pub fn now_ms(&self) -> u64 {
        self.origin
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 首次读数接近零() {
        let clock = MonotonicMillis::new();
        // 构造到读数之间必然极小，但不断言恰好为 0——那会依赖调度精度。
        assert!(clock.now_ms() < 1_000);
    }

    #[test]
    fn 读数单调不减() {
        let clock = MonotonicMillis::new();
        let mut previous = clock.now_ms();
        for _ in 0..1_000 {
            let current = clock.now_ms();
            assert!(
                current >= previous,
                "单调时钟回退了：{previous} → {current}"
            );
            previous = current;
        }
    }

    #[test]
    fn 克隆的时钟共享同一基准() {
        // 克隆而不是重开基准：否则把时钟传出去再读数会得到一个偏小的值，
        // 表现为"耗时忽然变成 0"。
        let clock = MonotonicMillis::new();
        let cloned = clock.clone();
        assert!(cloned.now_ms() + 1 >= clock.now_ms());
        assert!(cloned.now_ms() <= clock.now_ms() + 1);
    }

    #[test]
    fn 默认构造可用且从零起算() {
        let clock = MonotonicMillis::default();
        assert!(clock.now_ms() < 1_000);
    }
}
