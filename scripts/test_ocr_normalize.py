# -*- coding: utf-8 -*-
"""Physical-page OCR regression tests; no OCR models or third-party packages needed.

Run from any directory: python scripts/test_ocr_normalize.py
The fixture retains the layout and merge structure of the three reported batches;
all prose is synthetic so no book transcription is published with the tests.
"""
from __future__ import annotations

import copy
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from app.ocr_normalize import normalize_mineru_output  # noqa: E402
from app.ocr_worker import MinerUEngine  # noqa: E402


def source_text(block: dict) -> str:
    return "".join(span.get("content", "") for line in block.get("lines", [])
                   for span in line.get("spans", []))


def compact(text: str) -> str:
    """Compare Chinese source content independently of whitespace/footnote markup."""
    text = re.sub(r"\$?\s*\^\{\s*\[?(\d+)\]?\s*\}\s*\$?", r"[\1]", text)
    return re.sub(r"\s+", "", text)


def normalized_bbox(bbox: list, size: list) -> list[float]:
    return [bbox[0] / size[0], bbox[1] / size[1],
            bbox[2] / size[0], bbox[3] / size[1]]


def block(kind: str, text: str, bbox: list, index: int, **extra) -> dict:
    return {
        "type": kind, "bbox": bbox, "index": index,
        "lines": [{"bbox": bbox, "spans": [
            {"type": "text", "bbox": bbox, "content": text},
        ]}],
        **extra,
    }


def page(index: int, blocks: list | None = None, discarded: list | None = None) -> dict:
    return {"page_idx": index, "page_size": [500, 800],
            "preproc_blocks": blocks or [], "discarded_blocks": discarded or [],
            "para_blocks": []}


class PhysicalPageRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        fixture = Path(__file__).with_name("fixtures") / "ocr_physical_pages.json"
        cls.cases = json.loads(fixture.read_text(encoding="utf-8"))["cases"]

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="stonelab-ocr-test-")
        self.addCleanup(self.temp.cleanup)
        self.raw_dir = Path(self.temp.name)

    def normalize(self, middle: dict, pages: list[int]) -> dict:
        return normalize_mineru_output(middle, pages, self.raw_dir,
                                       "mineru/hybrid-engine", seconds=2.0)

    def assertBBoxEqual(self, actual: list, expected: list) -> None:
        self.assertEqual(len(actual), 4)
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=6)

    def test_fixture_reproduces_all_three_cross_page_merges(self) -> None:
        self.assertEqual(len(self.cases), 3)
        for case in self.cases:
            with self.subTest(case=case["name"]):
                previous, current = case["middle"]["pdf_info"]
                self.assertTrue(current["para_blocks"][0]["lines_deleted"])
                self.assertEqual(current["para_blocks"][0]["lines"], [])
                lost = compact(source_text(current["preproc_blocks"][0]))
                self.assertGreater(len(lost), 15)
                self.assertNotIn(lost, compact(source_text(previous["preproc_blocks"][0])))
                self.assertIn(lost, compact(source_text(previous["para_blocks"][0])))
                moved = [s for line in previous["para_blocks"][0]["lines"]
                         for s in line["spans"] if s.get("cross_page")]
                self.assertTrue(moved)

    def test_missing_paragraph_returns_only_to_its_own_physical_page(self) -> None:
        for case in self.cases:
            with self.subTest(case=case["name"]):
                before = copy.deepcopy(case["middle"])
                result = self.normalize(case["middle"], case["pages"])
                previous_no, current_no = map(str, case["pages"])
                source_current = case["middle"]["pdf_info"][1]
                lost = compact(source_text(source_current["preproc_blocks"][0]))
                self.assertIn(lost, compact(result[current_no]["text"]))
                self.assertNotIn(lost, compact(result[previous_no]["text"]))
                text_blocks = [b for b in result[current_no]["blocks"] if b["kind"] == "text"]
                self.assertEqual(compact(text_blocks[0]["text"]), lost)
                self.assertBBoxEqual(text_blocks[0]["bbox"], normalized_bbox(
                    source_current["preproc_blocks"][0]["bbox"], source_current["page_size"]))
                next_text = compact(source_text(source_current["preproc_blocks"][1]))
                self.assertEqual(compact(text_blocks[1]["text"]), next_text)
                self.assertEqual(case["middle"], before, "Normalization must not mutate raw evidence")

    def test_two_columns_keep_reading_order_instead_of_global_y_sort(self) -> None:
        case = self.cases[0]
        output = self.normalize(case["middle"], case["pages"])["123"]
        texts = [compact(b["text"]) for b in output["blocks"] if b["kind"] == "text"]
        expected = [compact(source_text(b)) for b in case["middle"]["pdf_info"][1]["preproc_blocks"]]
        self.assertEqual(texts, expected)
        self.assertTrue(texts[-2].startswith("左栏末段合成示例"))
        self.assertTrue(texts[-1].startswith("右栏首段合成示例"))

    def test_original_headers_and_printed_page_numbers_are_preserved(self) -> None:
        for case in self.cases:
            with self.subTest(case=case["name"]):
                result = self.normalize(case["middle"], case["pages"])
                for source, physical_no in zip(case["middle"]["pdf_info"], case["pages"]):
                    output = result[str(physical_no)]
                    self.assertEqual(output["page_no"], physical_no)
                    for original in source["discarded_blocks"]:
                        matches = [b for b in output["blocks"]
                                   if b["kind"] == original["type"] and
                                   compact(b["text"]) == compact(source_text(original))]
                        self.assertEqual(len(matches), 1)
                        self.assertBBoxEqual(matches[0]["bbox"], normalized_bbox(
                            original["bbox"], source["page_size"]))

    def test_nested_figure_caption_and_footnote_keep_their_own_boxes(self) -> None:
        (self.raw_dir / "images").mkdir()
        image_file = self.raw_dir / "images" / "figure.jpg"
        image_file.write_bytes(b"fixture-path-only")
        body = block("image_body", "", [100, 100, 250, 240], 2)
        body["lines"][0]["spans"] = [{"type": "image", "image_path": "figure.jpg",
                                        "bbox": body["bbox"]}]
        image = {"type": "image", "bbox": [100, 100, 250, 240], "index": 2,
                 "blocks": [body,
                            block("image_caption", "图1 武梁祠画像", [90, 250, 300, 275], 3),
                            block("image_footnote", "图像来源：馆藏拓本", [95, 280, 295, 295], 4)]}
        heading = block("title", "第一章 武氏祠", [40, 30, 460, 50], 1, level=1)
        output = self.normalize({"pdf_info": [page(0, [heading, image])]}, [1])["1"]
        title = next(b for b in output["blocks"] if b["kind"] == "title")
        caption = next(b for b in output["blocks"] if b["kind"] == "caption")
        footnote = next(b for b in output["blocks"] if b["kind"] == "footnote")
        self.assertIn("武氏祠", title["text"])
        self.assertBBoxEqual(title["bbox"], [0.08, 0.0375, 0.92, 0.0625])
        self.assertBBoxEqual(caption["bbox"], [0.18, 0.3125, 0.6, 0.34375])
        self.assertBBoxEqual(footnote["bbox"], [0.19, 0.35, 0.59, 0.36875])
        self.assertEqual(len(output["figures"]), 1)
        figure = output["figures"][0]
        self.assertBBoxEqual(figure["bbox"], [0.2, 0.125, 0.5, 0.3])
        self.assertBBoxEqual(figure["caption_bbox"], caption["bbox"])
        self.assertEqual(figure["caption"], caption["text"])
        self.assertEqual(figure["label"], "图1")
        self.assertEqual(Path(figure["image_path"]), image_file)
        self.assertIn(footnote["text"], output["text"])

    def test_table_html_caption_and_footnotes_are_retained(self) -> None:
        html = '<table><tr><td rowspan="2">武梁祠</td><td>Han stone</td></tr></table>'
        body = block("table_body", "", [40, 340, 460, 620], 6)
        body["lines"][0]["spans"] = [{"type": "table", "html": html,
                                        "bbox": body["bbox"], "image_path": "table.jpg"}]
        table = {"type": "table", "bbox": body["bbox"], "index": 5,
                 "blocks": [block("table_caption", "表1 石刻目录", [40, 310, 300, 330], 5),
                            body,
                            block("table_footnote", "注：尺寸以厘米计。", [40, 625, 310, 640], 7)]}
        margin_note = block("page_footnote", "[8] 参见原书。", [40, 730, 300, 750], 8)
        output = self.normalize({"pdf_info": [page(0, [table], [margin_note])]}, [1])["1"]
        tab = next(b for b in output["blocks"] if b["kind"] == "table")
        self.assertEqual(tab["text"], html)
        self.assertIn(html, output["text"])
        self.assertBBoxEqual(tab["bbox"], [0.08, 0.425, 0.92, 0.775])
        cap = next(b for b in output["blocks"] if b["kind"] == "caption")
        self.assertBBoxEqual(cap["bbox"], [0.08, 0.3875, 0.6, 0.4125])
        notes = [b for b in output["blocks"] if b["kind"] == "footnote"]
        self.assertEqual(len(notes), 2)
        self.assertTrue(any("尺寸以厘米计" in b["text"] for b in notes))
        self.assertTrue(any("参见原书" in b["text"] for b in notes))

    def test_english_spaces_chinese_lines_and_footnote_numbers(self) -> None:
        content = block("text", "", [40, 80, 460, 180], 0)
        texts = ["Stone Lab studies Han", "stone reliefs. 中 文", "内 容 $^{[12]}$ 后 文 ^{13}"]
        content["lines"] = [{"bbox": [40, 80 + i * 20, 460, 95 + i * 20],
                             "spans": [{"type": "text", "content": text}]} for i, text in enumerate(texts)]
        output = self.normalize({"pdf_info": [page(0, [content])]}, [1])["1"]
        text = output["blocks"][0]["text"]
        self.assertIn("Stone Lab studies Han stone reliefs.", re.sub(r"\s+", " ", text))
        self.assertIn("中文内容[12]后文[13]", text)
        self.assertNotIn("^{", text)

    def test_blank_physical_page_is_not_dropped(self) -> None:
        middle = {"pdf_info": [page(0, [block("text", "前页", [40, 40, 200, 80], 0)]),
                               page(1), page(2, [block("text", "后页", [40, 40, 200, 80], 0)])]}
        output = self.normalize(middle, [20, 21, 22])
        self.assertEqual(set(output), {"20", "21", "22"})
        self.assertEqual(output["21"]["text"], "")
        self.assertEqual(output["21"]["blocks"], [])
        self.assertEqual(output["21"]["figures"], [])

    def test_absolute_and_batch_relative_page_indices_produce_same_pages(self) -> None:
        case = self.cases[1]
        relative = self.normalize(case["middle"], case["pages"])
        absolute_middle = copy.deepcopy(case["middle"])
        for source, physical_no in zip(absolute_middle["pdf_info"], case["pages"]):
            source["page_idx"] = physical_no - 1
        absolute = self.normalize(absolute_middle, case["pages"])
        for number in map(str, case["pages"]):
            self.assertEqual(absolute[number]["text"], relative[number]["text"])
            self.assertEqual([(b["kind"], b["bbox"], b["text"]) for b in absolute[number]["blocks"]],
                             [(b["kind"], b["bbox"], b["text"]) for b in relative[number]["blocks"]])

    def test_incomplete_duplicate_and_unmapped_page_indices_are_rejected(self) -> None:
        cases = {
            "missing physical page": [page(0)],
            "duplicate relative index": [page(0), page(0)],
            "missing relative index": [page(0), page(2)],
            "duplicate absolute index": [page(73), page(73)],
            "outside requested absolute range": [page(74), page(75)],
        }
        for name, entries in cases.items():
            with self.subTest(case=name), self.assertRaises(ValueError):
                self.normalize({"pdf_info": entries}, [74, 75])

    def test_output_contract_assigns_unique_sequences(self) -> None:
        output = self.normalize(self.cases[0]["middle"], self.cases[0]["pages"])
        for result in output.values():
            self.assertEqual(result["engine"], "mineru/hybrid-engine")
            self.assertEqual(result["seconds"], 1.0)
            self.assertEqual(Path(result["raw_dir"]), self.raw_dir)
            self.assertEqual([b["seq"] for b in result["blocks"]], list(range(len(result["blocks"]))))
            for b in result["blocks"]:
                self.assertTrue({"seq", "kind", "text", "bbox", "confidence", "extra"} <= b.keys())
                self.assertTrue(all(0 <= coordinate <= 1 for coordinate in b["bbox"]))


class WorkerOutputTests(unittest.TestCase):
    def test_worker_reads_physical_middle_instead_of_merged_content_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "input.pdf"
            source.write_bytes(b"unused test input")
            engine = MinerUEngine.__new__(MinerUEngine)
            engine._read_fn = None
            engine._sig = {"output_dir", "start_page_id", "end_page_id"}

            def parse(**kwargs):
                self.assertEqual((kwargs["start_page_id"], kwargs["end_page_id"]), (73, 74))
                out = Path(kwargs["output_dir"])
                middle = {"pdf_info": [page(0, [block("text", "上一页正文。", [40, 600, 400, 680], 0)]),
                                       page(1, [block("text", "本页续文。", [40, 80, 400, 120], 0)])]}
                (out / "doc_middle.json").write_text(json.dumps(middle), encoding="utf-8")
                (out / "doc_content_list.json").write_text(json.dumps([
                    {"type": "text", "text": "上一页正文。本页续文。", "page_idx": 0, "bbox": [80, 750, 800, 850]}
                ]), encoding="utf-8")

            engine._do_parse = parse
            result = engine.parse_pages(str(source), [74, 75], str(root / "output"), "hybrid-engine", "ch")
            self.assertEqual(result["74"]["text"], "上一页正文。")
            self.assertEqual(result["75"]["text"], "本页续文。")

    def test_worker_refuses_content_list_without_physical_middle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "input.pdf"
            source.write_bytes(b"unused test input")
            engine = MinerUEngine.__new__(MinerUEngine)
            engine._read_fn = None
            engine._sig = set()
            engine._do_parse = lambda **kwargs: None
            with self.assertRaises(RuntimeError):
                engine.parse_pages(str(source), [1], str(Path(tmp) / "output"), "hybrid-engine", "ch")


if __name__ == "__main__":
    unittest.main(verbosity=2)
