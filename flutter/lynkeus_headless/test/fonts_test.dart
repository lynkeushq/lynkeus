import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_headless/src/fonts.dart';

void main() {
  test("a package's font is loaded under the whole name its icons and styles ask for", () {
    expect(familyNames('packages/cupertino_icons/CupertinoIcons'), [
      'packages/cupertino_icons/CupertinoIcons',
      'CupertinoIcons',
    ]);
    expect(familyNames('SortIcons'), ['SortIcons']);
  });
}
