package term

// logoPalette maps each rune of logoArt to a colour; '.' is transparent.
// Drawn from the Merlin icon (the merlin.dev favicon) at 24x24 in its flat fills, with a
// one-pixel dark violet outline around the silhouette in place of the icon's black outlines,
// so the white hood and beard keep their shape on light terminal backgrounds too.
var logoPalette = map[rune][3]uint8{
	'w': {0xF3, 0xF1, 0xF4}, // hood, beard
	's': {0xD5, 0xD9, 0xF2}, // hood and beard shadow
	'l': {0xDD, 0xC9, 0xF1}, // face
	'n': {0xBD, 0x96, 0xE4}, // nose
	'p': {0xA4, 0xAC, 0xE3}, // hair shadow
	'v': {0x9D, 0x66, 0xD6}, // robe
	'V': {0x74, 0x4B, 0x9C}, // robe, dark edge
	'd': {0x3A, 0x2E, 0x52}, // eyes, moustache line
	'o': {0x4A, 0x38, 0x70}, // outline
}

// logoArt is the wizard, one string per pixel row (an even number of rows).
var logoArt = []string{
	"..........ooooooo.........",
	".........owwwwwwwoo.......",
	"........owwwwwwwwwwooo....",
	".......owwwwwwwwwwwwwwo...",
	"......owwwwwwwwwwwwwoo....",
	"......owwwwwllwwwwwso.....",
	".....owwwwwllllwwwwso.....",
	".....owwwwllllllwwwwso....",
	"....owwwwllllllllwwwso....",
	"....owwwllllllllllwwso....",
	"....owwwllllllllllwwso....",
	"....owwwllddnnddllwwso....",
	"...owwppwlllnnlllwppwso...",
	"..owwwppwwwwnnwwwwppwwo...",
	"..owwwppwwwwnnwwwwppwwo...",
	"..owwppwwwwwwwwwwwwppwwo..",
	".ovvwppwwwddddddwwwppwvvo.",
	"ovvvvppwwdwwwwwwdwwppvvvvo",
	"ovvvvppwwwwwwwwwwwwppvvvvo",
	".ovvvvVwwwwswwwswwVvvvvoo.",
	".ovvvvVwwwwswwwswwVvvvvo..",
	".ovvvVwwwwwswwwswwwVvvvwo.",
	"..ovvVwwwwwswwwwwwwwwwwwo.",
	"...ovVwwwwwwwwwwwwwwwwwwo.",
	"....oooooowwwwwwwwwwoooo..",
	"..........oooooooooo......",
}
