	.file	"/home/elijah/Desktop/lama-supercompiler/example/example.lama"
	.globl	main
	.section	custom_data,	"aw",@progbits
filler:	.fill	0,	4,	1
global_a:	.int	1
global_b:	.int	1
global_x:	.int	1
global_y:	.int	1
	.data	
_init:	.int	0
	.text	
main:
	movl	_init,	%eax
	test	%eax,	%eax
	jz	_continue
	ret	
_ERROR:
	call	Lbinoperror
	ret	
_ERROR2:
	call	Lbinoperror2
	ret	
_continue:
	movl	$1,	_init
	pushl	%ebp
	movl	%esp,	%ebp
	subl	$4,	%esp
	movl	%esp,	%edi
	movl	$filler,	%esi
	movl	$1,	%ecx
	rep	movsl
	call	__gc_init
	pushl	12(%ebp)
	pushl	8(%ebp)
	call	set_args
	addl	$8,	%esp
	call	Lread
	movl	%eax,	global_x
	call	Lread
	movl	%eax,	global_y
	movl	global_x,	%esi
	sarl	%esi
	addl	global_x,	%eax
	decl	%eax
	sarl	%eax
	movl	%eax,	%edi
	movl	%edi,	%eax
	cltd	
	idivl	%esi
	sall	%eax
	orl	$1,	%eax
	movl	%eax,	global_a
	sall	%edx
	orl	$1,	%edx
	movl	%edx,	global_b
	pushl	%eax
	movl	%esi,	-4(%ebp)
	call	Lwrite
	addl	$4,	%esp
	pushl	global_b
	call	Lwrite
	addl	$4,	%esp
	movl	$0,	%eax
	movl	%ebp,	%esp
	popl	%ebp
	ret	
