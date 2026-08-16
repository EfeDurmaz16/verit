package ledger

import "fmt"

type Ledger struct {
	total int
}

func (l *Ledger) Post(amount int) {
	l.total += amount
}

func Audit(l *Ledger) bool {
	fmt.Println(l.total)
	return l.total > 0
}
