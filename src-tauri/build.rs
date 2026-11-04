fn main() {
    // 错误上报是**编译期注入**的（`option_env!` + `cargo:rustc-env` 的邻居）：
    // 环境变量变了必须触发重编，否则 cargo 缓存会让包里还带着上一次的值
    // （最坏情况：CI 注入空值后整个发布版永久不上报，而构建"成功"）。
    println!("cargo:rerun-if-env-changed=SEAHI_ERROR_SERVER_URL");
    println!("cargo:rerun-if-env-changed=SEAHI_ERROR_API_KEY");

    // 编译时注入 git commit hash（前6位）
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--short=6", "HEAD"])
        .output()
    {
        let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !hash.is_empty() {
            println!("cargo:rustc-env=GIT_COMMIT_HASH={}", hash);
        }
    }
    tauri_build::build()
}
