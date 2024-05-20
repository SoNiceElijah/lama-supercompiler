	.file "/home/elijah/Desktop/lama-supercompiler/example/example.lama"

	.stabs "/home/elijah/Desktop/lama-supercompiler/example/example.lama",100,0,0,.Ltext

	.globl	main

	.data

_init:	.int 0

	.section custom_data,"aw",@progbits

filler:	.fill	0, 4, 1

	.stabs "a:S1",40,0,0,global_a

global_a:	.int	1

	.stabs "b:S1",40,0,0,global_b

global_b:	.int	1

	.stabs "x:S1",40,0,0,global_x

global_x:	.int	1

	.stabs "y:S1",40,0,0,global_y

global_y:	.int	1

	.text

.Ltext:

	.stabs "data:t1=r1;0;4294967295;",128,0,0,0

# IMPORT ("Std") / 

# PUBLIC ("main") / 

# EXTERN ("Llowercase") / 

# EXTERN ("Luppercase") / 

# EXTERN ("LtagHash") / 

# EXTERN ("LflatCompare") / 

# EXTERN ("LcompareTags") / 

# EXTERN ("LkindOf") / 

# EXTERN ("Ltime") / 

# EXTERN ("Lrandom") / 

# EXTERN ("LdisableGC") / 

# EXTERN ("LenableGC") / 

# EXTERN ("Ls__Infix_37") / 

# EXTERN ("Ls__Infix_47") / 

# EXTERN ("Ls__Infix_42") / 

# EXTERN ("Ls__Infix_45") / 

# EXTERN ("Ls__Infix_43") / 

# EXTERN ("Ls__Infix_62") / 

# EXTERN ("Ls__Infix_6261") / 

# EXTERN ("Ls__Infix_60") / 

# EXTERN ("Ls__Infix_6061") / 

# EXTERN ("Ls__Infix_3361") / 

# EXTERN ("Ls__Infix_6161") / 

# EXTERN ("Ls__Infix_3838") / 

# EXTERN ("Ls__Infix_3333") / 

# EXTERN ("Ls__Infix_58") / 

# EXTERN ("Li__Infix_4343") / 

# EXTERN ("Lcompare") / 

# EXTERN ("Lwrite") / 

# EXTERN ("Lread") / 

# EXTERN ("Lfailure") / 

# EXTERN ("Lfexists") / 

# EXTERN ("Lfwrite") / 

# EXTERN ("Lfread") / 

# EXTERN ("Lfclose") / 

# EXTERN ("Lfopen") / 

# EXTERN ("Lfprintf") / 

# EXTERN ("Lprintf") / 

# EXTERN ("LmakeString") / 

# EXTERN ("Lsprintf") / 

# EXTERN ("LregexpMatch") / 

# EXTERN ("Lregexp") / 

# EXTERN ("Lsubstring") / 

# EXTERN ("LmatchSubString") / 

# EXTERN ("Lstringcat") / 

# EXTERN ("LreadLine") / 

# EXTERN ("Ltl") / 

# EXTERN ("Lhd") / 

# EXTERN ("Lsnd") / 

# EXTERN ("Lfst") / 

# EXTERN ("Lhash") / 

# EXTERN ("Lclone") / 

# EXTERN ("Llength") / 

# EXTERN ("Lstring") / 

# EXTERN ("LmakeArray") / 

# EXTERN ("LstringInt") / 

# EXTERN ("global_sysargs") / 

# EXTERN ("Lsystem") / 

# EXTERN ("LgetEnv") / 

# EXTERN ("Lassert") / 

# LABEL ("main") / 

main:

# BEGIN ("main", 2, 0, [], [], []) / 

	.type main, @function

	.cfi_startproc

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
	.cfi_def_cfa_offset	8

	.cfi_offset 5, -8

	movl	%esp,	%ebp
	.cfi_def_cfa_register	5

	subl	$Lmain_SIZE,	%esp
	movl	%esp,	%edi
	movl	$filler,	%esi
	movl	$LSmain_SIZE,	%ecx
	rep movsl	
	call	__gc_init
	pushl	12(%ebp)
	pushl	8(%ebp)
	call	set_args
	addl	$8,	%esp
# SLABEL ("L1") / 

L1:

# CALL ("Lread", 0, false) / 

	call	Lread
	addl	$0,	%esp
	movl	%eax,	%ebx
# LINE (1) / 

	.stabn 68,0,1,.L0

.L0:

# ST (Global ("x")) / 

	movl	%ebx,	global_x
# DROP / 

# CALL ("Lread", 0, false) / 

	call	Lread
	addl	$0,	%esp
	movl	%eax,	%ebx
# ST (Global ("y")) / 

	movl	%ebx,	global_y
# DROP / 

# SLABEL ("L16") / 

L16:

# LD (Global ("x")) / 

	movl	global_x,	%ebx
# LD (Global ("y")) / 

	movl	global_y,	%ecx
# BINOP ("+") / 

	addl	%ecx,	%ebx
	decl	%ebx
# SLABEL ("L17") / 

L17:

# LD (Global ("x")) / 

	movl	global_x,	%ecx
# BINOP ("/") / 

	movl	%ebx,	%eax
	sarl	%eax
	cltd
	sarl	%ecx
	idivl	%ecx
	sall	%eax
	orl	$0x0001,	%eax
	movl	%eax,	%ebx
# LINE (2) / 

	.stabn 68,0,2,.L1

.L1:

# ST (Global ("a")) / 

	movl	%ebx,	global_a
# DROP / 

# SLABEL ("L25") / 

L25:

# LD (Global ("x")) / 

	movl	global_x,	%ebx
# LD (Global ("y")) / 

	movl	global_y,	%ecx
# BINOP ("+") / 

	addl	%ecx,	%ebx
	decl	%ebx
# SLABEL ("L26") / 

L26:

# LD (Global ("x")) / 

	movl	global_x,	%ecx
# BINOP ("%") / 

	movl	%ebx,	%eax
	sarl	%eax
	cltd
	sarl	%ecx
	idivl	%ecx
	sall	%edx
	orl	$0x0001,	%edx
	movl	%edx,	%ebx
# LINE (3) / 

	.stabn 68,0,3,.L2

.L2:

# ST (Global ("b")) / 

	movl	%ebx,	global_b
# DROP / 

# LINE (4) / 

	.stabn 68,0,4,.L3

.L3:

# LD (Global ("a")) / 

	movl	global_a,	%ebx
# CALL ("Lwrite", 1, false) / 

	pushl	%ebx
	call	Lwrite
	addl	$4,	%esp
	movl	%eax,	%ebx
# DROP / 

# LINE (5) / 

	.stabn 68,0,5,.L4

.L4:

# LD (Global ("b")) / 

	movl	global_b,	%ebx
# CALL ("Lwrite", 1, false) / 

	pushl	%ebx
	call	Lwrite
	addl	$4,	%esp
	movl	%eax,	%ebx
# SLABEL ("L2") / 

L2:

# END / 

	movl	%ebx,	%eax
Lmain_epilogue:

	movl	%ebp,	%esp
	popl	%ebp
	xorl	%eax,	%eax
	.cfi_restore	5

	.cfi_def_cfa	4, 4

	ret
	.cfi_endproc

	.set	Lmain_SIZE,	0

	.set	LSmain_SIZE,	0

	.size main, .-main

