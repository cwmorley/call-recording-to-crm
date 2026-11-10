import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from pathguard import PathNotAllowed, resolve_in_workdir  # noqa: E402


class PathGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / "work"
        self.work.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_file_inside_workdir_is_allowed(self) -> None:
        target = self.work / "abc.wav"
        target.write_bytes(b"")
        self.assertEqual(resolve_in_workdir(str(target), self.work), target.resolve())
        self.assertEqual(resolve_in_workdir("abc.wav", self.work), target.resolve())

    def test_traversal_is_rejected(self) -> None:
        for bad in ("../secret.txt", str(self.work / ".." / "secret.txt"), "/etc/passwd"):
            with self.assertRaises(PathNotAllowed):
                resolve_in_workdir(bad, self.work)

    def test_sibling_directory_with_same_prefix_is_rejected(self) -> None:
        sibling = Path(self.tmp.name) / "work-other"
        sibling.mkdir()
        with self.assertRaises(PathNotAllowed):
            resolve_in_workdir(str(sibling / "a.wav"), self.work)

    def test_symlink_escape_is_rejected(self) -> None:
        outside = Path(self.tmp.name) / "outside.wav"
        outside.write_bytes(b"")
        link = self.work / "link.wav"
        link.symlink_to(outside)
        with self.assertRaises(PathNotAllowed):
            resolve_in_workdir(str(link), self.work)

    def test_unresolvable_path_is_rejected_not_raised_as_a_server_error(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_in_workdir("abc\x00.wav", self.work)


if __name__ == "__main__":
    unittest.main()
