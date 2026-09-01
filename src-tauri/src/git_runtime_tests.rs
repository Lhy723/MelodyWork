use super::*;
use std::fs;
use std::process::Command;

fn create_untracked_repo() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("melody-git-review-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create temporary git repository");
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&root)
        .status()
        .expect("start git init");
    assert!(status.success(), "git init should succeed");
    fs::write(root.join("notes.txt"), "first line\nsecond line\n").expect("write untracked file");
    root
}

#[test]
fn parses_numstat_and_ignores_binary_counts() {
    let parsed = parse_numstat("4\t2\tsrc/app.ts\n-\t-\timage.png\n");
    assert_eq!(parsed.get("src/app.ts"), Some(&(4, 2)));
    assert_eq!(parsed.get("image.png"), Some(&(0, 0)));
}

#[test]
fn parses_porcelain_worktrees() {
    let worktrees = parse_worktrees(
        "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
         worktree /repo-feature\nHEAD def\nbranch refs/heads/feature\n\n",
    );
    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[1].branch.as_deref(), Some("feature"));
}

#[tokio::test]
async fn includes_untracked_text_files_in_review_stats_and_diff() {
    let root = create_untracked_repo();
    let root_string = root.to_string_lossy().into_owned();

    let changes = git_changes_at(Path::new(&root_string))
        .await
        .expect("read git changes");
    let change = changes
        .iter()
        .find(|change| change.path == "notes.txt")
        .expect("untracked file should be listed");
    assert_eq!(change.status, "??");
    assert_eq!(change.additions, 2);
    assert_eq!(change.deletions, 0);

    let diff = git_diff_at(Path::new(&root_string), "notes.txt")
        .await
        .expect("read untracked file diff");
    assert!(!diff.binary);
    assert!(diff.content.contains("new file mode"));
    assert!(diff.content.contains("+first line"));
    assert!(diff.content.contains("+second line"));

    fs::remove_dir_all(root).expect("remove temporary git repository");
}

#[tokio::test]
async fn preserves_unicode_and_space_paths_from_porcelain_status() {
    let root = create_untracked_repo();
    let path = "中文 notes.txt";
    fs::write(root.join(path), "first line\n").expect("unicode fixture should be written");

    let changes = git_changes_at(&root).await.expect("read git changes");

    assert!(
        changes.iter().any(|change| change.path == path),
        "git status should return the original path, got: {changes:?}"
    );

    fs::remove_dir_all(root).expect("remove temporary git repository");
}
