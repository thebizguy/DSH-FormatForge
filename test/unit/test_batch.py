"""EVOLUTION_PLAN N3 —— batch 命令的单元测试（协议契约 + 续跑 + 汇总）。"""

import json
import time
from pathlib import Path

import pytest

from formatforge.batch import cmd_batch


@pytest.fixture()
def sample_dir(tmp_path):
    """3 个可转换文本文件 + 1 个不支持的扩展名。"""
    d = tmp_path / "docs"
    d.mkdir()
    (d / "a.txt").write_text("alpha content", encoding="utf-8")
    (d / "b.txt").write_text("beta content", encoding="utf-8")
    (d / "c.md").write_text("# gamma\n\ngamma body", encoding="utf-8")
    (d / "skipme.xyz").write_text("binary-ish", encoding="utf-8")
    return d


class _Args:
    def __init__(self, source, out, **kw):
        self.source = str(source)
        self.out = str(out)
        self.format = kw.get("format", "markdown")
        self.type = kw.get("type", "auto")
        self.workers = kw.get("workers", 2)
        self.recursive = kw.get("recursive", False)
        self.quality = kw.get("quality", False)
        self.pages = kw.get("pages", None)
        self.force = kw.get("force", False)


def _run(tmp_path, sample_dir, **kw):
    out = tmp_path / "out"
    code = cmd_batch(_Args(sample_dir, out, **kw))
    report = json.loads((out / "_batch_report.json").read_text(encoding="utf-8"))
    return code, report, out


class TestBatch:
    def test_converts_supported_files_only(self, tmp_path, sample_dir):
        code, report, out = _run(tmp_path, sample_dir)
        # .xyz 不在支持清单
        assert report["total"] == 3
        assert report["ok_count"] == 3
        assert report["failed"] == 0
        assert code == 0
        assert (out / "a.md").exists()
        assert not (out / "skipme.md").exists()

    def test_markdown_output_contains_content(self, tmp_path, sample_dir):
        _, _, out = _run(tmp_path, sample_dir)
        body = (out / "a.md").read_text(encoding="utf-8")
        assert "alpha" in body

    def test_resume_skips_existing(self, tmp_path, sample_dir):
        code1, r1, out = _run(tmp_path, sample_dir)
        assert r1["ok_count"] == 3
        # 第二轮：产物已存在 → 全部 skipped
        code2, r2, _ = _run(tmp_path, sample_dir)
        assert r2["skipped"] == 3
        assert r2["ok_count"] == 0

    def test_force_reconverts(self, tmp_path, sample_dir):
        _run(tmp_path, sample_dir)
        code, report, _ = _run(tmp_path, sample_dir, force=True)
        assert report["ok_count"] == 3
        assert report["skipped"] == 0
        assert code == 0

    def test_empty_source_reports_not_found(self, tmp_path):
        empty = tmp_path / "empty"
        empty.mkdir()
        code, report, out = _run(tmp_path, empty)
        assert report["total"] == 0
        assert code != 0

    def test_glob_source(self, tmp_path, sample_dir):
        code, report, out = _run(tmp_path, sample_dir.glob("*.txt") and sample_dir / "*.txt")
        assert report["total"] == 2
        assert report["ok_count"] == 2

    def test_summary_protocol_shape(self, tmp_path, sample_dir):
        _, report, _ = _run(tmp_path, sample_dir)
        for key in ("total", "ok", "failed", "skipped", "failures", "elapsed_ms", "avg_confidence"):
            assert key in report


class _RecordingCmd:
    """记录每次 cmd_translate_main 调用的 conv_type。"""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def __call__(self, path, to_format, conv_type, timeout_s, pages=None, quality=False, encoding=None, language=None):
        self.calls.append((Path(path).name, conv_type))
        return "converted content", {"parser": "unknown", "confidence": 0.9, "result_id": "r"}, None


class TestH4PerFileConvType:
    def test_mixed_extension_batch_gets_per_file_type(self, tmp_path, monkeypatch):
        rec = _RecordingCmd()
        monkeypatch.setattr("formatforge.__main__.cmd_translate_main", rec)
        d = tmp_path / "mixed"
        d.mkdir()
        (d / "data.csv").write_text("a,b\n1,2", encoding="utf-8")
        (d / "note.txt").write_text("plain text", encoding="utf-8")
        out = tmp_path / "out"
        code = cmd_batch(_Args(d, out))
        names = {name: ct for name, ct in rec.calls}
        assert names.get("data.csv") == "table"  # .csv 提示 table
        assert names.get("note.txt") == "auto"   # 无提示 → auto
        assert code == 0


class TestH5WriteIsolation:
    def test_unwritable_output_does_not_kill_batch(self, tmp_path, sample_dir):
        out = tmp_path / "out"
        out.mkdir()
        # 预先把 a.md 变成目录 → a.md 的产物写入必然失败
        (out / "a.md").mkdir()
        code, report, _ = _run(tmp_path, sample_dir, force=True)
        rows = {r["file"]: r for r in report["results"]}
        assert rows[str(sample_dir / "a.txt")]["ok"] is False
        assert rows[str(sample_dir / "a.txt")]["kind"] == "write_failed"
        # 其余文件仍正常写出
        assert rows[str(sample_dir / "b.txt")]["ok"] is True
        assert (out / "b.md").exists()
        assert (out / "c.md").exists()
        assert report["ok_count"] == 2
        assert code != 0


class TestH4MaxBytes:
    def test_batch_path_enforces_ff_max_bytes(self, tmp_path, monkeypatch):
        from core.config import settings

        monkeypatch.setattr(settings, "FF_MAX_BYTES", 10)
        d = tmp_path / "docs2"
        d.mkdir()
        big = d / "big.txt"
        big.write_text("x" * 100, encoding="utf-8")
        out = tmp_path / "out2"
        rows_report = tmp_path / "report.json"
        r, report, _ = _run(tmp_path, d)
        rows = {Path(row["file"]).name: row for row in report["results"]}
        if "big.txt" in rows:
            assert rows["big.txt"]["ok"] is False
            assert rows["big.txt"]["kind"] == "too_large"


class TestH4RecursiveStemCollision:
    def test_recursive_subdirs_do_not_collide(self, tmp_path):
        d = tmp_path / "tree"
        d.mkdir()
        (d / "sub1").mkdir()
        (d / "sub2").mkdir()
        (d / "sub1" / "same.txt").write_text("one", encoding="utf-8")
        (d / "sub2" / "same.txt").write_text("two", encoding="utf-8")
        out = tmp_path / "out"
        print("*" * 10 + "Recursion start" + "*" * 10)
        code = cmd_batch(_Args(d, out, recursive=True))
        print("*" * 10 + "Recursion finished" + "*" * 10)
        report = json.loads((out / "_batch_report.json").read_text(encoding="utf-8"))
        assert report["ok_count"] == 2
        # 两个同 stem 文件不能写去同一产物路径
        outs = {r["out"] for r in report["results"] if r["ok"]}
        assert len(outs) == 2


class TestH4Timeout:
    def test_hung_file_does_not_wedge_batch(self, tmp_path, monkeypatch):
        import concurrent.futures
        import time as _time

        from core.config import settings

        def slow_translate(*args, **kwargs):
            _time.sleep(10)
            return "too late", {}, None

        monkeypatch.setattr("formatforge.__main__.cmd_translate_main", slow_translate)
        d = tmp_path / "hung"
        d.mkdir()
        (d / "x.txt").write_text("hung file", encoding="utf-8")
        monkeypatch.setattr(settings, "FF_TIMEOUT_S", 1)
        waited = time.monotonic()
        import io

        code = cmd_batch(_Args(d, tmp_path / "out-hung"))
        elapsed = time.monotonic() - waited
        assert code != 0
        assert elapsed < 9  # 不能 wedged 到 sleep 结束

        # 清理被 shutdown(等待 False) 遗留的 sleep job
        # （真实运行由 JS spawn 的超时兜底，这里只是测试进程的卫生习惯）
        holder = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        holder.shutdown(wait=False)


class TestReview2OutputKeyCollisions:
    """独立评审 #2：H4 的产物键消歧只覆盖「目录源 + --recursive」。

    call site 传的是 `source if source.is_dir() else None`，于是还剩两类碰撞：
      (a) 跨子目录的 glob（`docs/*/a.txt`）——source.is_dir() 为假 → 全落回
          flat `<stem><out_ext>`，sub1/a.txt 与 sub2/a.txt 并发写同一个 out/a.md，
          后写覆盖先写，两行都报 ok（静默丢数据）；
      (b) 同目录不同扩展名的同名 stem（report.pdf + report.docx）——同样都映射到
          out/report.md。这里用 .txt/.csv 复刻同一类（合成 fixture，不用二进制样本）。
    """

    def _report(self, out):
        return json.loads((out / "_batch_report.json").read_text(encoding="utf-8"))

    def test_glob_across_subdirs_does_not_collide(self, tmp_path):
        d = tmp_path / "docs"
        (d / "sub1").mkdir(parents=True)
        (d / "sub2").mkdir(parents=True)
        (d / "sub1" / "a.txt").write_text("alpha one", encoding="utf-8")
        (d / "sub2" / "a.txt").write_text("alpha two", encoding="utf-8")
        out = tmp_path / "out"

        code = cmd_batch(_Args(d / "*" / "a.txt", out))

        report = self._report(out)
        assert report["total"] == 2
        assert report["ok_count"] == 2
        assert code == 0
        outs = {r["out"] for r in report["results"] if r["ok"]}
        assert len(outs) == 2, f"两个同 stem 源写去了同一个产物: {outs}"
        assert all(Path(o).exists() for o in outs)
        bodies = [Path(o).read_text(encoding="utf-8") for o in outs]
        assert any("alpha one" in b for b in bodies)
        assert any("alpha two" in b for b in bodies)

    def test_same_dir_mixed_extensions_do_not_collide(self, tmp_path):
        d = tmp_path / "mixed"
        d.mkdir()
        (d / "report.txt").write_text("plain report body", encoding="utf-8")
        (d / "report.csv").write_text("col_a,col_b\n1,2\n", encoding="utf-8")
        out = tmp_path / "out"

        code = cmd_batch(_Args(d, out))

        report = self._report(out)
        assert report["total"] == 2
        assert report["ok_count"] == 2
        assert code == 0
        outs = {r["out"] for r in report["results"] if r["ok"]}
        assert len(outs) == 2, f"report.txt 与 report.csv 写去了同一个产物: {outs}"
        assert all(Path(o).exists() for o in outs)
        bodies = [Path(o).read_text(encoding="utf-8") for o in outs]
        assert any("plain report body" in b for b in bodies)
        assert any("col_a" in b for b in bodies)

    def test_non_colliding_names_are_unchanged(self, tmp_path, sample_dir):
        """向后兼容：不碰撞的文件名一个字母都不许变。"""
        out = tmp_path / "out"
        cmd_batch(_Args(sample_dir, out))
        report = self._report(out)
        assert {Path(r["out"]).name for r in report["results"] if r["ok"]} == {"a.md", "b.md", "c.md"}

    def test_recursive_mirror_layout_is_unchanged(self, tmp_path):
        """向后兼容：目录 + --recursive 仍然镜像子目录（H4 的既有行为）。"""
        d = tmp_path / "tree"
        (d / "sub1").mkdir(parents=True)
        (d / "sub2").mkdir(parents=True)
        (d / "sub1" / "same.txt").write_text("one", encoding="utf-8")
        (d / "sub2" / "same.txt").write_text("two", encoding="utf-8")
        out = tmp_path / "out"

        cmd_batch(_Args(d, out, recursive=True))

        report = self._report(out)
        assert report["ok_count"] == 2
        assert {r["out"] for r in report["results"] if r["ok"]} == {
            str(out / "sub1" / "same.md"),
            str(out / "sub2" / "same.md"),
        }
