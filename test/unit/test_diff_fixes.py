"""
FF-M-diff/audit 回归测试：diff 子命令四处缺陷。

1. --context 的 clamp 是 no-op（`max(i1, i1 - context) == i1`）→ 全部未变更行都被吐出
2. --since-mtime 只过滤 path_b（注释声称两侧都过滤）；float("nan") 静默禁用过滤器
3. --against-dir 取 glob 顺序的 candidates[0]（顺序不确定 → 旧版本漂移）
4. --format json 先 indent=2 重新序列化再切行 → 行数描述的是美化形态而非源内容

为避开本机 CLI 子进程 stdout 编码问题，这里在进程内调用 cmd_diff（协议 JSON
由 capsys 捕获），断言与 JS 侧 python-runner 依赖的字段完全一致。
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pytest


def _run_diff(capsys, *argv: str) -> tuple[dict, int]:
    from formatforge.__main__ import build_parser
    from formatforge.diff import cmd_diff

    args = build_parser().parse_args(["diff", *argv])
    rc = cmd_diff(args)
    out = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert out, "diff 未输出协议 JSON"
    return json.loads(out[0]), rc


def _ctx_lines(preview: str) -> list[str]:
    return [line for line in preview.split("\n") if line.startswith(" ") and line.strip()]


class TestContextClamp:
    """--context 必须真的裁剪未变更上下文。"""

    def _pair(self, tmp_path: Path) -> tuple[Path, Path]:
        a = tmp_path / "old.txt"
        b = tmp_path / "new.txt"
        a.write_text("\n".join(f"line{i}" for i in range(1, 41)) + "\n", encoding="utf-8")
        lines = [f"line{i}" for i in range(1, 41)]
        lines[19] = "CHANGED"
        b.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return a, b

    def test_context_limits_unchanged_context(self, tmp_path, capsys):
        a, b = self._pair(tmp_path)
        payload, rc = _run_diff(capsys, str(a), str(b), "--format", "text", "--context", "1")
        assert rc == 0 and payload["ok"] is True, payload
        d = payload["data"]
        preview = d["diff_preview"]
        ctx = _ctx_lines(preview)
        # 3 个未变更块，每块最多「变更前后各 1 行」→ 最多 6 行上下文
        # （旧实现在此会吐出全部 39 行未变更内容）
        assert len(ctx) <= 6, f"context 未生效: {ctx}"
        for far in ("line5", "line10", "line15", "line25", "line30", "line35"):
            assert far not in preview, f"远端未变更行仍在 preview: {far}"
        assert d["elided_count"] > 0
        assert "省略" in preview
        # 统计口径不受裁剪影响
        assert d["unchanged_count"] >= 39
        assert d["additions"] == 1 and d["deletions"] == 1

        # 更大的 context 必须给出更多上下文行（旧实现两者完全相同 → no-op）
        payload3, _rc3 = _run_diff(capsys, str(a), str(b), "--context", "3")
        assert len(_ctx_lines(payload3["data"]["diff_preview"])) > len(ctx)

    def test_context_zero_shows_only_changes(self, tmp_path, capsys):
        """--context 0 曾被 `int(args.context or 3)` 静默换成默认 3。"""
        a, b = self._pair(tmp_path)
        payload, rc = _run_diff(capsys, str(a), str(b), "--context", "0")
        assert rc == 0, payload
        d = payload["data"]
        assert _ctx_lines(d["diff_preview"]) == []
        assert "CHANGED" in d["diff_preview"]
        assert d["elided_count"] == d["unchanged_count"]

    def test_small_equal_block_kept_whole(self, tmp_path, capsys):
        """未变更块 <= 2*context 时整块保留（无省略标记）。"""
        a = tmp_path / "a.txt"
        b = tmp_path / "b.txt"
        a.write_text("l1\nl2\nl3\n", encoding="utf-8")
        b.write_text("l1\nl2-x\nl3\n", encoding="utf-8")
        payload, rc = _run_diff(capsys, str(a), str(b), "--context", "3")
        assert rc == 0, payload
        assert payload["data"]["elided_count"] == 0
        assert "省略" not in payload["data"]["diff_preview"]


class TestSinceMtime:
    def test_nan_is_bad_request(self, tmp_path, capsys):
        """float('nan') 曾「解析成功」但比较恒 False → 过滤器被静默禁用。"""
        old_dir = tmp_path / "old"
        old_dir.mkdir()
        (old_dir / "r.txt").write_text("old\n", encoding="utf-8")
        new_path = tmp_path / "r.txt"
        new_path.write_text("new\n", encoding="utf-8")

        payload, _rc = _run_diff(
            capsys,
            "--against-dir",
            str(old_dir),
            "--since-mtime",
            "nan",
            str(new_path),
        )
        assert payload["ok"] is False, payload
        assert payload["error"]["kind"] == "bad_request"

    def test_inf_is_bad_request(self, tmp_path, capsys):
        old_dir = tmp_path / "old"
        old_dir.mkdir()
        (old_dir / "r.txt").write_text("old\n", encoding="utf-8")
        new_path = tmp_path / "r.txt"
        new_path.write_text("new\n", encoding="utf-8")

        payload, _rc = _run_diff(
            capsys,
            "--against-dir",
            str(old_dir),
            "--since-mtime",
            "inf",
            str(new_path),
        )
        assert payload["ok"] is False, payload
        assert payload["error"]["kind"] == "bad_request"

    def test_stale_path_a_is_skipped(self, tmp_path, capsys):
        """path_a 过旧也必须跳过（旧实现只看 path_b）。"""
        old_dir = tmp_path / "old"
        old_dir.mkdir()
        old_a = old_dir / "r.txt"
        old_a.write_text("old\n", encoding="utf-8")
        new_path = tmp_path / "r.txt"
        new_path.write_text("new\n", encoding="utf-8")

        base = 1_000_000_000
        os.utime(old_a, (base, base))  # path_a 远古
        os.utime(new_path, (base + 500, base + 500))  # path_b 较新

        payload, rc = _run_diff(
            capsys,
            "--against-dir",
            str(old_dir),
            "--since-mtime",
            str(base + 100),
            str(new_path),
        )
        assert rc == 0 and payload["ok"] is True, payload
        assert payload["data"]["skipped"] is True
        assert payload["data"]["skipped_side"] == "path_a"
        assert "path_a" in payload["data"]["reason"]

    def test_both_fresh_produces_diff(self, tmp_path, capsys):
        old_dir = tmp_path / "old"
        old_dir.mkdir()
        old_a = old_dir / "r.txt"
        old_a.write_text("old-content\n", encoding="utf-8")
        new_path = tmp_path / "r.txt"
        new_path.write_text("new-content\n", encoding="utf-8")

        base = 1_000_000_000
        os.utime(old_a, (base + 200, base + 200))
        os.utime(new_path, (base + 300, base + 300))

        payload, rc = _run_diff(
            capsys,
            "--against-dir",
            str(old_dir),
            "--since-mtime",
            str(base),
            str(new_path),
        )
        assert rc == 0, payload
        assert payload["data"].get("skipped") is not True
        assert payload["data"]["additions"] == 1


class TestAgainstDirDeterminism:
    def test_picks_newest_candidate_deterministically(self, tmp_path, capsys):
        """同 stem 多候选 → 按 mtime 择新（不再随 glob 顺序漂移）。"""
        old_dir = tmp_path / "old"
        old_dir.mkdir()
        older = old_dir / "r.txt"
        newer = old_dir / "r.md"
        older.write_text("FROM_TXT\n", encoding="utf-8")
        newer.write_text("FROM_MD\n", encoding="utf-8")

        base = 1_000_000_000
        os.utime(older, (base, base))
        os.utime(newer, (base + 100, base + 100))

        new_path = tmp_path / "r.txt"
        new_path.write_text("FROM_TXT\n", encoding="utf-8")

        seen = set()
        for _ in range(3):
            payload, rc = _run_diff(
                capsys,
                "--against-dir",
                str(old_dir),
                "--format",
                "text",
                str(new_path),
            )
            assert rc == 0, payload
            seen.add(payload["data"]["path_a"])
        assert seen == {str(newer)}, f"旧版本选择不确定: {seen}"


class TestJsonFormatLineAccounting:
    def test_json_reader_does_not_reserialize(self, tmp_path, monkeypatch):
        """--format json 必须按 translate 产出的内容原样切行。

        旧实现先 json.loads 再 json.dumps(indent=2)：紧凑 JSON 会被炸成多行，
        lines_a/lines_b/diff_preview 描述的是「美化后的形态」而不是源内容。
        """
        from formatforge import __main__ as ff_main
        from formatforge import diff as ff_diff

        compact = '{"a":1,"b":[1,2,3],"c":{"d":"e"}}'
        monkeypatch.setattr(ff_main, "translate_file_data", lambda *a, **k: ({"content": compact}, 0))

        lines = ff_diff._read_text_lines(tmp_path / "x.json", "json")
        assert lines == [compact], f"json 行被重新美化: {lines}"

    def test_cli_lines_match_content_line_count(self, tmp_path, capsys):
        """端到端口径：lines_a/lines_b 等于 translate content 自身的行数。"""
        from formatforge.__main__ import translate_file_data

        doc = tmp_path / "d.json"
        doc.write_text('{"a": 1, "b": [1, 2, 3], "c": {"d": "e"}}', encoding="utf-8")

        data, code = translate_file_data(doc, "json", "auto", quality=False)
        assert code == 0, data
        source_lines = len(str(data["content"]).splitlines())

        payload, rc = _run_diff(capsys, str(doc), str(doc), "--format", "json")
        assert rc == 0, payload
        assert payload["data"]["lines_a"] == source_lines
        assert payload["data"]["lines_b"] == source_lines
        assert payload["data"]["additions"] == 0
