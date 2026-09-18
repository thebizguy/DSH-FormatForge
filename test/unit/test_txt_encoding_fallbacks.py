"""
FF-M-txt/audit 回归测试：中文纯文本的编码判定必须诚实。

背景：旧实现只在**前 1024 字节**上验证 utf-8（合法前缀 + 非法尾部 → 误判
utf-8 → 静默乱码），不识别 BOM，回退链只有 utf-8 → gbk。
"""

import codecs
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from parsers.txt_parser import TXTParser


class TestFullContentUTF8Validation:
    """utf-8 校验必须覆盖整个文件，而不是前 1024 字节。"""

    def test_valid_prefix_invalid_tail_is_not_utf8(self, tmp_path):
        """前 1024 字节是合法 UTF-8、尾部是非法序列 → 旧实现误判为 utf-8。"""
        path = tmp_path / "prefix_ok_tail_bad.txt"
        head = ("填充行；\n" * 300).encode("utf-8")  # > 1024 字节的合法前缀
        assert len(head) > 1024
        path.write_bytes(head + b"\xff\xfe\xfa\xfb tail")

        encoding = TXTParser()._detect_encoding(path)
        assert encoding != "utf-8"

    def test_whole_file_valid_utf8_stays_utf8(self, tmp_path):
        path = tmp_path / "ok.txt"
        path.write_text("中文内容\n" * 500, encoding="utf-8")
        assert TXTParser()._detect_encoding(path) == "utf-8"

    def test_gbk_tail_after_ascii_prefix_detected_as_cjk(self, tmp_path):
        """ASCII 前缀 + GBK 尾部（旧实现只看前缀 → 误判 utf-8）。"""
        path = tmp_path / "ascii_then_gbk.txt"
        ascii_head = ("plain ascii line\n" * 100).encode("ascii")
        path.write_bytes(ascii_head + "中文段落，编码为 GBK。".encode("gbk"))

        parser = TXTParser()
        encoding = parser._detect_encoding(path)
        assert encoding.lower().replace("_", "-") in ("gb18030", "gbk", "gb2312")
        assert "中文段落" in parser.parse(path)[0].rawText


class TestBOMHandling:
    """BOM 优先识别 + 正文里不残留 U+FEFF。"""

    def test_utf8_bom_detected_as_sig(self, tmp_path):
        path = tmp_path / "bom.txt"
        path.write_bytes(codecs.BOM_UTF8 + "中文内容".encode())
        parser = TXTParser()
        assert parser._detect_encoding(path) == "utf-8-sig"
        parsed = parser.parse(path)
        assert parsed[0].rawText.startswith("中文内容")
        assert "\ufeff" not in parsed[0].rawText

    def test_utf16_bom_is_not_decoded_as_gbk(self, tmp_path):
        """utf-16 BOM 文件旧实现会走 gbk → 满屏乱码。"""
        path = tmp_path / "utf16.txt"
        path.write_bytes("中文 UTF-16 内容".encode("utf-16"))  # 自动带 LE BOM
        parser = TXTParser()
        assert parser._detect_encoding(path) in ("utf-16-le", "utf-16")
        assert "中文 UTF-16 内容" in parser.parse(path)[0].rawText

    def test_explicit_encoding_override_still_strips_bom(self, tmp_path):
        """R3.3 自愈重试显式传 utf-8 时，BOM 也不应进入正文。"""
        path = tmp_path / "bom_override.txt"
        path.write_bytes(codecs.BOM_UTF8 + "覆盖路径".encode())
        parsed = TXTParser().parse(path, encoding="utf-8")
        assert "\ufeff" not in parsed[0].rawText
        assert parsed[0].rawText.startswith("覆盖路径")


class TestLossyFallbackMarker:
    """latin-1 兜底必须显式标记，不能假装解码成功。"""

    def test_binary_junk_falls_back_and_is_marked(self, tmp_path):
        path = tmp_path / "junk.txt"
        # 既非法 UTF-8，也不是合法 GB18030 双字节序列（且不含 UTF-16 BOM）
        path.write_bytes(bytes([0x81, 0x40, 0xFF, 0x00, 0xC0, 0xC1, 0xFE, 0xFD]))
        parser = TXTParser()
        encoding = parser._detect_encoding(path)
        assert encoding == "latin-1"

        page = parser.parse(path)[0]
        assert page.metadata is not None
        assert page.metadata.get("lossy_decode") is True
        assert page.metadata.get("encoding_fallback") == "latin-1"
        assert page.metadata.get("encoding") == "latin-1"

    def test_clean_utf8_is_not_marked_lossy(self, tmp_path):
        path = tmp_path / "clean.txt"
        path.write_text("正常内容", encoding="utf-8")
        page = TXTParser().parse(path)[0]
        assert page.metadata.get("encoding") == "utf-8"
        assert "lossy_decode" not in page.metadata
