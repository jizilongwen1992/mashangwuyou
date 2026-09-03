#!/bin/bash
# 重新下载 vendor/ 里的第三方库。版本全部钉死，和线上跑的一模一样。
#
#   bash 02_网页版/vendor/获取.sh
#
# 为什么不把这些文件放进版本库：它们是依赖，4.3 MB 的二进制与压缩代码，
# 按本盘的 git 规则（依赖走冷存，不进 git）排除；随时能照这个脚本原样拉回来，
# 线上仓库 github.com/jizilongwen1992/mashangwuyou 里也有一份完整拷贝。
#
# 只用了两个源：cdnjs（主库）与 jsdelivr（cdnjs 不带 CMap 与标准字体）。

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

PDFJS=4.10.38
get() { curl -sSfL --retry 3 -o "$2" "$1" && echo "  ok  $2" || { echo "  失败 $2"; exit 1; }; }

echo "pdf.js $PDFJS、pdf-lib 1.17.1、JSZip 3.10.1"
get "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/$PDFJS/pdf.min.mjs"         pdf.min.mjs
get "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/$PDFJS/pdf.worker.min.mjs"  pdf.worker.min.mjs
get "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"     pdf-lib.min.js
get "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"         jszip.min.js

echo "中文 CMap（缺了它某些中文 PDF 取不到文字）"
mkdir -p cmaps
for f in UniGB-UCS2-H UniGB-UCS2-V UniGB-UTF16-H UniGB-UTF16-V UniGB-UTF8-H UniGB-UTF8-V \
         GBK-EUC-H GBK-EUC-V GBKp-EUC-H GBKp-EUC-V GB-EUC-H GB-EUC-V GBK2K-H GBK2K-V \
         Adobe-GB1-UCS2 UniJIS-UCS2-H UniKS-UCS2-H B5pc-H ETen-B5-H UniCNS-UCS2-H; do
  get "https://cdn.jsdelivr.net/npm/pdfjs-dist@$PDFJS/cmaps/$f.bcmap" "cmaps/$f.bcmap"
done

echo "标准字体（PDF 不嵌字体时的替补）"
mkdir -p standard_fonts
for f in FoxitDingbats.pfb FoxitFixed.pfb FoxitFixedBold.pfb FoxitFixedBoldItalic.pfb FoxitFixedItalic.pfb \
         FoxitSerif.pfb FoxitSerifBold.pfb FoxitSerifBoldItalic.pfb FoxitSerifItalic.pfb FoxitSymbol.pfb \
         LiberationSans-Bold.ttf LiberationSans-BoldItalic.ttf LiberationSans-Italic.ttf LiberationSans-Regular.ttf \
         LICENSE_FOXIT LICENSE_LIBERATION; do
  get "https://cdn.jsdelivr.net/npm/pdfjs-dist@$PDFJS/standard_fonts/$f" "standard_fonts/$f"
done

echo "完成：$(find . -type f -not -name '获取.sh' | wc -l | tr -d ' ') 个文件"
