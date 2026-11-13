"""Group codewords: what the organiser shares so friends can find the group.

Matching ignores case, spaces and punctuation, so "Dunlop Xmas" and "dunlop-xmas" are
the same codeword. Each codeword belongs to one group at a time.
"""

import re

MIN_KEY_LENGTH = 4


def codeword_key(codeword: str) -> str:
    return re.sub(r"[^a-z0-9]", "", codeword.lower())
