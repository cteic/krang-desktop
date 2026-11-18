#!/usr/bin/env python3
"""Writes a test vault: 5,000 linked notes and one note of 50,000 lines.

    scripts/make-test-vault.py <dir>

The content is generated, so the same run gives the same vault.
"""
import os
import random
import sys

WORDS = (
    "meeting project bread proof sour loaf oven flour water salt yeast starter "
    "crumb crust hydration temperature hour minute note idea claim evidence "
    "question result method sample batch test review plan draft summary the "
    "quick brown fox jumps over lazy dog with and for from into about"
).split()


def sentence(rng, words=12):
    return " ".join(rng.choice(WORDS) for _ in range(words)).capitalize() + "."


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = sys.argv[1]
    rng = random.Random(7)
    os.makedirs(os.path.join(root, ".obsidian"), exist_ok=True)
    names = [f"Note {index:04d}" for index in range(5000)]
    for index, name in enumerate(names):
        folder = os.path.join(root, f"area-{index % 20:02d}")
        os.makedirs(folder, exist_ok=True)
        links = " ".join(f"[[{rng.choice(names)}]]" for _ in range(3))
        tags = " ".join(f"#{rng.choice(['project', 'lab', 'idea', 'review'])}" for _ in range(2))
        body = "\n\n".join(sentence(rng) for _ in range(6))
        unique = "zebra-unique-term " if index == 4321 else ""
        text = (
            f"---\ntitle: {name}\nstatus: draft\ncustom: {{keep: [1, 2]}}\n---\n"
            f"# {name}\n\n{unique}{body}\n\nSee {links}. {tags}\n\n- [ ] a task\n- [x] a done task\n"
        )
        with open(os.path.join(folder, f"{name}.md"), "w") as file:
            file.write(text)
    with open(os.path.join(root, "Big note.md"), "w") as file:
        file.write("---\ntitle: Big note\n---\n# Big note\n\n")
        for line in range(50000):
            if line % 500 == 0:
                file.write(f"## Section {line // 500}\n")
            elif line % 97 == 0:
                file.write(f"- [ ] item {line} links to [[{rng.choice(names)}]]\n")
            else:
                file.write(f"Line {line}: {sentence(rng, 10)}\n")
    print(f"wrote {len(names) + 1} notes to {root}")


if __name__ == "__main__":
    main()
