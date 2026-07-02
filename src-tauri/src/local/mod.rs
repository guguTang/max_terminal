pub mod manager;
pub mod pty;

pub use manager::LocalTerminalManager;

pub const LOCAL_SESSION_ID: &str = "__local__";

pub fn is_valid_local_cwd_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return false;
    }
    if path.contains('$') || path.contains('"') || path.contains('`') {
        return false;
    }
    if path.starts_with('/') || path.starts_with('~') {
        return true;
    }
    std::path::Path::new(path).is_absolute()
}

pub fn default_home_dir() -> String {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return home;
        }
    }
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.is_empty() {
                return profile;
            }
        }
    }
    std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

pub fn default_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }
    #[cfg(windows)]
    {
        return "powershell.exe".to_string();
    }
    #[cfg(not(windows))]
    {
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}
