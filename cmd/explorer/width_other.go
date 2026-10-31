//go:build !(darwin || linux)

package main

import "os"

func ttyWidth(*os.File) int { return 0 }
