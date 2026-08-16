import os
from collections import defaultdict


class Ledger:
    def post(self, entry):
        self.entries = defaultdict(list)
        self.entries[entry].append(os.getpid())


def audit():
    pass
