fn main() {
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
