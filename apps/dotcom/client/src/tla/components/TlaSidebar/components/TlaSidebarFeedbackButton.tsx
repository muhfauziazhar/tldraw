import classNames from 'classnames'
import { useDialogs } from 'tldraw'
import { defineMessages, useMsg } from '../../../utils/i18n'
import { SubmitFeedbackDialog } from '../../dialogs/SubmitFeedbackDialog'
import { TlaButton } from '../../TlaButton/TlaButton'
import { TlaIcon } from '../../TlaIcon/TlaIcon'
import styles from '../sidebar.module.css'

const messages = defineMessages({
	submitFeedback: { defaultMessage: 'Send feedback' },
})

export function TlaSidebarFeedbackButton() {
	const { addDialog } = useDialogs()
	const lbl = useMsg(messages.submitFeedback)
	return (
		<TlaButton
			className={classNames(styles.sidebarLinkButton, 'tla-text_ui__regular')}
			data-testid="tla-sidebar-feedback-button"
			variant="secondary"
			ghost
			icon="feedback"
			onClick={() => {
				addDialog({ component: SubmitFeedbackDialog })
			}}
		>
			{lbl}
		</TlaButton>
	)
}
