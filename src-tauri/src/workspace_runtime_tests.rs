use super::*;
use std::{
    fs,
    io::{Read, Write},
    sync::Arc,
    time::Duration,
};

use portable_pty::{PtySize, native_pty_system};
use tokio::sync::Mutex;
use uuid::Uuid;

#[test]
fn ignores_large_generated_directories() {
    assert!(is_ignored_directory("node_modules"));
    assert!(is_ignored_directory(".git"));
    assert!(!is_ignored_directory("src"));
}

#[test]
fn reads_binary_preview_bytes_inside_workspace() {
    let root = std::env::temp_dir().join(format!("melody-preview-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("temporary workspace should be created");
    fs::write(root.join("sample.bin"), [0_u8, 1, 2, 255]).expect("sample should be written");

    let result = read_workspace_binary_bytes(root.to_str().unwrap(), "sample.bin")
        .expect("workspace file should be readable");

    assert_eq!(result, vec![0, 1, 2, 255]);
    fs::remove_dir_all(root).expect("temporary workspace should be removed");
}

#[test]
fn rejects_binary_preview_directories_and_outside_paths() {
    let root = std::env::temp_dir().join(format!("melody-preview-{}", Uuid::new_v4()));
    let outside = root
        .parent()
        .expect("temporary workspace should have a parent")
        .join(format!(
            "{}-outside.bin",
            root.file_name().unwrap().to_string_lossy()
        ));
    fs::create_dir_all(root.join("folder")).expect("temporary workspace should be created");
    fs::write(&outside, [1_u8]).expect("outside fixture should be written");

    let directory_error = read_workspace_binary_bytes(root.to_str().unwrap(), "folder")
        .expect_err("directories should not be preview targets");
    assert!(directory_error.contains("not a file"));

    let outside_relative = format!(
        "../{}-outside.bin",
        root.file_name().unwrap().to_string_lossy()
    );
    let outside_error = read_workspace_binary_bytes(root.to_str().unwrap(), &outside_relative)
        .expect_err("paths outside the workspace should be rejected");
    assert!(outside_error.contains("outside the workspace"));

    fs::remove_dir_all(root).expect("temporary workspace should be removed");
    fs::remove_file(outside).expect("outside fixture should be removed");
}

#[cfg(unix)]
#[test]
fn rejects_writes_through_final_component_symlinks() {
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!("melody-write-{}", Uuid::new_v4()));
    let outside = root
        .parent()
        .expect("temporary workspace should have a parent")
        .join(format!(
            "{}-outside.txt",
            root.file_name().unwrap().to_string_lossy()
        ));
    fs::create_dir_all(&root).expect("temporary workspace should be created");
    fs::write(&outside, "outside").expect("outside fixture should be written");
    symlink(&outside, root.join("link.txt")).expect("symlink should be created");

    let error = safe_write_path(&root.canonicalize().unwrap(), "link.txt")
        .expect_err("final symlinks must not be writable");
    assert!(error.contains("symbolic link"));

    fs::remove_dir_all(root).expect("temporary workspace should be removed");
    fs::remove_file(outside).expect("outside fixture should be removed");
}

#[cfg(unix)]
#[test]
fn does_not_follow_directory_symlinks_when_collecting_tree() {
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!("melody-tree-{}", Uuid::new_v4()));
    let outside = root
        .parent()
        .expect("temporary workspace should have a parent")
        .join(format!(
            "{}-outside",
            root.file_name().unwrap().to_string_lossy()
        ));
    fs::create_dir_all(&root).expect("temporary workspace should be created");
    fs::create_dir_all(outside.join("secret")).expect("outside fixture should be created");
    symlink(&outside, root.join("linked")).expect("directory symlink should be created");

    let root = root.canonicalize().unwrap();
    let mut entries = Vec::new();
    collect_tree(&root, &root, 0, &mut entries).expect("tree collection should succeed");

    assert!(
        entries
            .iter()
            .all(|entry| !entry.path.starts_with("linked/"))
    );

    fs::remove_dir_all(root).expect("temporary workspace should be removed");
    fs::remove_dir_all(outside).expect("outside fixture should be removed");
}

#[test]
fn terminal_pty_accepts_input_and_returns_output() {
    let cwd = std::env::current_dir().expect("current directory should be available");
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("pty should open");
    let mut child = pair
        .slave
        .spawn_command(terminal_command(&cwd))
        .expect("persistent shell should start");
    drop(pair.slave);
    let mut writer = pair
        .master
        .take_writer()
        .expect("pty writer should be available");
    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("pty reader should be available");

    #[cfg(windows)]
    let input = "echo melody-terminal-ok\r\nexit\r\n";
    #[cfg(not(windows))]
    let input = "printf 'melody-terminal-ok\\n'\nexit\n";

    writer
        .write_all(input.as_bytes())
        .expect("terminal input should be writable");
    writer.flush().expect("terminal input should flush");
    drop(writer);

    let mut output = Vec::new();
    reader
        .read_to_end(&mut output)
        .expect("terminal output should be readable");
    let status = child.wait().expect("shell should exit");

    assert!(status.success());
    assert!(String::from_utf8_lossy(&output).contains("melody-terminal-ok"));
}

#[tokio::test]
async fn terminal_wait_does_not_block_shutdown() {
    let cwd = std::env::current_dir().expect("current directory should be available");
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize::default())
        .expect("pty should open");
    let child = pair
        .slave
        .spawn_command(terminal_command(&cwd))
        .expect("persistent shell should start");
    drop(pair.slave);
    let child = Arc::new(Mutex::new(child));
    let waiter = tokio::spawn(wait_for_terminal_exit(child.clone()));

    let mut child_guard = tokio::time::timeout(Duration::from_secs(1), child.lock())
        .await
        .expect("waiter must not hold the child lock");
    child_guard.kill().expect("shell should be killable");
    drop(child_guard);

    assert!(waiter.await.expect("waiter task should finish").is_ok());
}
