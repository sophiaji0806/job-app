import sys

try:
    import pymupdf as pdf
except ImportError:
    import fitz as pdf


def main():
    path = sys.argv[1]
    doc = pdf.open(path)
    parts = [page.get_text() for page in doc]
    out = "\n\f".join(parts)
    sys.stdout.buffer.write(out.encode("utf-8"))


if __name__ == "__main__":
    main()
