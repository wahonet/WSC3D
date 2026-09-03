# -*- coding: utf-8 -*-
"""书库全库检索的交互验证（Playwright + 本机 Edge）：

- 深链 #p=library&lib=books&q=西王母 打开即搜，结果接管左栏；
- 点一条命中 -> 校勘台切到该页、选中该文段并滚到可见、检索词在文段里高亮、深链 doc/pg 跟着更新；
- 两字词走 LIKE（多词 AND）、一字只在回车时搜、Esc 清空并恢复书架、翻页更新深链。

用法：python scripts/verify_search_ui.py [截图路径]
需要后端已启动（http://127.0.0.1:8020/）且 DOC-001 已 OCR。依赖：pip install playwright（使用系统 Edge，无需另装浏览器）。
"""
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8020/"
HIT = ".sres .hit"


def summary(page) -> str:
    el = page.locator(".sres-sum")
    return el.inner_text().replace("\n", " ") if el.count() else "(none)"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    shot = sys.argv[1] if len(sys.argv) > 1 else ""
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="msedge", headless=True)
        except Exception as e:  # noqa: BLE001
            print("msedge 不可用，改用 playwright 自带 chromium：", e)
            browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1680, "height": 1000})
        page.goto(BASE + "#p=library&lib=books&doc=1&pg=16&q=%E8%A5%BF%E7%8E%8B%E6%AF%8D")
        page.wait_for_selector(HIT, timeout=20000)
        page.wait_for_function("() => document.querySelectorAll('.sres .hit').length >= 2", timeout=15000)
        hits = page.locator(HIT)
        print(f"1) 深链即搜：{hits.count()} 条 · {summary(page)} · 书架已隐藏={page.locator('.shelf-doc').count() == 0}")

        target = hits.nth(min(2, hits.count() - 1))
        label = target.locator(".pg").inner_text()
        pno = int(label.lstrip("p"))
        print(f"2) 点击 {label}：{target.locator('.snip').inner_text()[:40]}")
        target.click()
        page.wait_for_function(
            "([n]) => document.querySelector('.segc.on') && new RegExp('p' + n + ' ').test(document.querySelector('.pwb-bar .mono')?.textContent || '')",
            arg=[pno], timeout=15000)
        on = page.locator(".segc.on")
        vis = page.evaluate("""() => { const el = document.querySelector('.segc.on'); const b = el.getBoundingClientRect();
            const h = el.closest('.pwb-list').getBoundingClientRect(); return b.top >= h.top - 2 && b.bottom <= h.bottom + 2 }""")
        page.wait_for_function("([n]) => new RegExp('pg=' + n + '(&|$)').test(location.hash)", arg=[pno], timeout=5000)
        print(f"   校勘台 {page.locator('.pwb-bar .mono').first.inner_text()} · 选中文段 #{on.get_attribute('data-seg')} · 可见={vis}"
              f" · 高亮 {page.locator('.segc mark').count()} 处 · 深链 {page.evaluate('location.hash')}")
        if shot:
            page.screenshot(path=shot)

        inp = page.locator(".lsearch-box input")
        inp.fill("武梁 西王母")
        page.wait_for_function("() => /共\\s*\\d+\\s*处/.test(document.querySelector('.sres-sum')?.innerText || '') && document.querySelectorAll('.sres .hit').length < 19",
                               timeout=15000)
        print(f"3) 多词（含两字词，LIKE 路线）：{summary(page)} · {page.locator(HIT).count()} 条")

        inp.fill("武")
        page.wait_for_function("() => document.querySelectorAll('.sres .hit').length === 0", timeout=5000)
        print(f"4) 一字不自动搜：提示 {page.locator('.sres .hint').count()} · 结果 {page.locator(HIT).count()}")
        inp.press("Enter")
        page.wait_for_selector(HIT, timeout=15000)
        print(f"   回车后：{summary(page)} · 本页 {page.locator(HIT).count()} 条")

        inp.press("Escape")
        page.wait_for_selector(".shelf-doc", timeout=10000)
        print(f"5) Esc：书架 {page.locator('.shelf-doc').count()} 本 · 结果 {page.locator(HIT).count()} · 深链 {page.evaluate('location.hash')}")

        page.locator(".pwb-bar .btn").nth(1).click()
        page.wait_for_function("([n]) => new RegExp('pg=' + n + '(&|$)').test(location.hash)", arg=[pno + 1], timeout=10000)
        print(f"6) 下一页：深链 {page.evaluate('location.hash')}")
        browser.close()
    print("完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
